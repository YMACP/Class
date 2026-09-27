// The registry is shared by model declarations, canonicalization and execution.
import { fileToolDefinitions } from './file-tools.js';
import { webToolDefinitions } from './web-tools.js';
import { browserToolDefinitions } from './browser-tools.js';
import { mediaToolDefinitions } from './media-tools.js';
import { planningToolDefinitions } from './planning-tools.js';
import { memoryToolDefinitions, isMemoryTool } from './memory-tools.js';

const aliases = Object.freeze({ readFile: 'read_file', listFiles: 'list_files', readEvidence: 'read_evidence', runCommand: 'run_command' });
const string = (description, extra = {}) => ({ type: 'string', ...(description ? { description } : {}), ...extra });
const nonempty = description => string(description, { minLength: 1 });
const definition = (name, description, properties, required = []) => ({ name, description, parameters: { type: 'object', properties, required, additionalProperties: false } });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function invalid(code, message, context) { return Object.assign(new Error(message), { code, reasonCode: code, memberRecoverable: true, ...context }); }

// JSON.parse silently replaces duplicate keys. Check every object, including
// escaped spellings of the same name, before returning the parsed value.
export function parseUniqueJSON(text, label = 'JSON') {
  if (typeof text !== 'string') throw invalid('TOOL_ARGUMENT_INVALID', label + ' must be JSON text');
  let value;
  try { value = JSON.parse(text); } catch { throw invalid('TOOL_ARGUMENT_INVALID', label + ' is not valid JSON'); }
  let cursor = 0;
  const whitespace = () => { while (cursor < text.length && /\s/.test(text[cursor])) cursor++; };
  function quoted() {
    const start = cursor++;
    while (cursor < text.length) { if (text[cursor++] === '\\') cursor++; else if (text[cursor - 1] === '"') break; }
    return JSON.parse(text.slice(start, cursor));
  }
  function visit(depth = 0) {
    if (depth > 128) throw invalid('TOOL_ARGUMENT_INVALID', label + ' nesting is too deep');
    whitespace();
    if (text[cursor] === '{') {
      cursor++; whitespace(); const seen = new Set();
      while (text[cursor] !== '}') {
        const key = quoted();
        if (seen.has(key)) throw invalid('TOOL_ARGUMENT_INVALID', label + ' contains duplicate object keys');
        seen.add(key); whitespace(); cursor++; visit(depth + 1); whitespace();
        if (text[cursor] !== ',') break;
        cursor++; whitespace();
      }
      cursor++;
    } else if (text[cursor] === '[') {
      cursor++; whitespace();
      while (text[cursor] !== ']') { visit(depth + 1); whitespace(); if (text[cursor] !== ',') break; cursor++; whitespace(); }
      cursor++;
    } else if (text[cursor] === '"') quoted();
    else while (cursor < text.length && !/[\s,\]}]/.test(text[cursor])) cursor++;
  }
  visit(); return value;
}

export function toolDefinitions(manager, { includeLegacy = false } = {}) {
  if (!manager) return [];
  const definitions = [
    definition('read_file', 'Read a UTF-8 file inside the configured working directory.', { path: nonempty('Path relative to the working directory.') }, ['path']),
    definition('list_files', 'List names inside a working-directory folder.', { path: nonempty('Relative folder path; defaults to the working directory.') }),
    definition('sleep', 'Wait for the specified amount of active, unpaused time.', { ms: { type: 'number', minimum: 0, maximum: 86400000 } }, ['ms']),
    ...fileToolDefinitions, ...webToolDefinitions, ...browserToolDefinitions, ...mediaToolDefinitions, ...planningToolDefinitions,
    ...(manager.memory ? memoryToolDefinitions : []),
  ];
  if (manager.allowShell) {
    const shells = Array.isArray(manager.availableShells) ? manager.availableShells : process.platform === 'win32' ? ['powershell'] : ['bash'];
    if (shells.length) definitions.push(definition('run_command',
      'Execute a complete foreground script. Default interpreter: ' + (manager.defaultShell || shells[0]) + '. Supports pipelines and multi-line scripts. Do not supply executable argument arrays. Background or detached work is unsupported. A failed command is an execution result, not a malformed tool call.',
      { command: nonempty('Complete script to execute; never an empty object.'), shell: string('Optional detected interpreter.', { enum: shells }), cwd: nonempty('Optional folder within the configured workspace.') }, ['command']));
    if (includeLegacy) definitions.push(definition('shell', 'Compatibility only: run an executable directly, without shell parsing.', {
      command: nonempty('Executable name or path, not a script.'), args: { type: 'array', items: { type: 'string' } }, cwd: nonempty('Optional folder within the workspace.'),
    }, ['command']));
  }
  if (typeof manager.evidenceReader === 'function') definitions.push(definition('read_evidence', 'Read persisted task evidence by reference, tool callId or member. For large output, use reference, byteOffset and maxBytes, then continue at nextOffset.', {
    reference: nonempty(), studentId: nonempty(), member: nonempty('Alias for studentId.'), kind: nonempty(),
    offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 }, byteOffset: { type: 'integer', minimum: 0 }, maxBytes: { type: 'integer', minimum: 4, maximum: 65536 },
  }));
  return definitions;
}
const argumentAliases = {
  run_command: { script: 'command', cmd: 'command', code: 'command', workdir: 'cwd', workingDirectory: 'cwd', working_directory: 'cwd' },
  shell: { executable: 'command', cmd: 'command', argv: 'args', workdir: 'cwd', workingDirectory: 'cwd', working_directory: 'cwd' },
  read_file: { file: 'path', filename: 'path', filePath: 'path', file_path: 'path' },
  list_files: { directory: 'path', dir: 'path', folder: 'path' },
  sleep: { durationMs: 'ms', duration_ms: 'ms', milliseconds: 'ms' },
  read_evidence: { member: 'studentId', memberId: 'studentId', member_id: 'studentId', call_id: 'reference', callId: 'reference' },
};
const wrappers = ['args', 'arguments', 'parameters', 'input'];
const executionControls = new Set(['timeout', 'timeoutMs', 'timeout_ms', 'timeoutSeconds', 'timeout_seconds', 'stdin', 'stdinData', 'stdin_data', 'input', 'env', 'environment', 'background', 'detached', 'async', 'runInBackground', 'run_in_background', 'encoding', 'interactive', 'pty', 'tty', 'flags', 'executable', 'script', 'shell', 'parameters', 'arguments', 'args', 'argv']);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function validateValue(value, schema, label, context, depth = 0) {
  if (depth > 20) throw invalid('TOOL_ARGUMENT_INVALID', 'Tool argument nesting is too deep: ' + label, context);
  const validType = schema.type === 'object' ? object(value) : schema.type === 'array' ? Array.isArray(value)
    : schema.type === 'integer' ? Number.isSafeInteger(value) : schema.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
    : !schema.type || typeof value === schema.type;
  if (!validType || (schema.enum && !schema.enum.includes(value)) || (schema.minimum !== undefined && value < schema.minimum)
    || (schema.maximum !== undefined && value > schema.maximum) || (schema.minLength !== undefined && (value.length < schema.minLength || (label !== 'old_text' && !value.trim())))
    || (schema.maxLength !== undefined && value.length > schema.maxLength) || (schema.minItems !== undefined && value.length < schema.minItems)
    || (schema.maxItems !== undefined && value.length > schema.maxItems)) throw invalid('TOOL_ARGUMENT_INVALID', 'Invalid tool argument: ' + label, context);
  if (Array.isArray(value) && schema.items) value.forEach((item, index) => validateValue(item, schema.items, label + '[' + index + ']', context, depth + 1));
  if (object(value) && schema.type === 'object') {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw invalid('TOOL_ARGUMENT_INVALID', 'Missing tool argument: ' + label + '.' + key, context);
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties || {}, key)) validateValue(item, schema.properties[key], label + '.' + key, context, depth + 1);
      else if (schema.additionalProperties === false) throw invalid('TOOL_ARGUMENT_INVALID', 'Unknown tool argument: ' + label + '.' + key, context);
    }
  }
}

export function inspectToolCall(rawName, rawArguments, { definitions = [] } = {}) {
  const byName = new Map(definitions.map(tool => [tool.name, tool]));
  const name = byName.has(rawName) ? rawName : typeof rawName === 'string' && Object.hasOwn(aliases, rawName) ? aliases[rawName] : rawName;
  const context = { rawToolName: rawName, rawArguments, canonicalToolName: byName.has(name) ? name : undefined, toolName: rawName };
  if (typeof name !== 'string' || !byName.has(name)) throw invalid('TOOL_NAME_INVALID', 'Unknown tool name. Allowed tools: ' + definitions.map(tool => tool.name).join(', '), context);
  let input = rawArguments;
  if (typeof input === 'string') { try { input = parseUniqueJSON(input, 'Tool arguments'); } catch (error) { throw invalid('TOOL_ARGUMENT_INVALID', error.message, context); } }
  if (!object(input)) throw invalid('TOOL_ARGUMENT_INVALID', 'Tool arguments must be an object', context);
  const schema = byName.get(name).parameters, properties = schema?.properties || {};
  let normalized = name !== rawName, entries = Object.entries(input);
  const wrapped = wrappers.filter(key => Object.hasOwn(input, key) && object(input[key]) && properties[key]?.type !== 'object');
  if (wrapped.length > 1) throw invalid('TOOL_ARGUMENT_INVALID', 'Tool arguments contain multiple ambiguous wrappers', context);
  if (wrapped.length) {
    const wrapper = wrapped[0], inner = input[wrapper];
    if (wrappers.some(key => object(inner[key]) && properties[key]?.type !== 'object')) throw invalid('TOOL_ARGUMENT_INVALID', 'Only one tool argument wrapper is supported', context);
    entries = [...entries.filter(([key]) => key !== wrapper), ...Object.entries(inner)]; normalized = true;
  }
  const args = {};
  for (const [originalKey, value] of entries) {
    if (['name', 'tool', 'toolName', 'tool_name'].includes(originalKey) && !Object.hasOwn(properties, originalKey)) {
      const repeatedName = typeof value === 'string' && Object.hasOwn(aliases, value) ? aliases[value] : value;
      if (repeatedName !== name) throw invalid('TOOL_ARGUMENT_INVALID', 'A repeated tool name conflicts with the actual tool call', context);
      normalized = true; continue;
    }
    if (name === 'run_command' && ['args', 'argv', 'arguments'].includes(originalKey)) throw invalid('TOOL_ARGUMENT_INVALID', 'run_command requires a complete script; use legacy shell for executable argument arrays', context);
    const key = argumentAliases[name] && Object.hasOwn(argumentAliases[name], originalKey) ? argumentAliases[name][originalKey] : originalKey;
    if (['run_command', 'shell'].includes(name) && executionControls.has(originalKey) && !Object.hasOwn(properties, key)) throw invalid('TOOL_ARGUMENT_INVALID', 'Unsupported command execution control: use only the declared command parameters', context);
    if (!Object.hasOwn(properties, key) && schema?.additionalProperties !== true) {
      if (isMemoryTool(name)) throw invalid('TOOL_ARGUMENT_INVALID', 'Unknown memory tool argument: ' + key, context);
      normalized = true; continue;
    }
    if (Object.hasOwn(args, key) && !same(args[key], value)) throw invalid('TOOL_ARGUMENT_INVALID', 'Conflicting tool arguments must not overwrite each other', context);
    Object.defineProperty(args, key, { value, writable: true, enumerable: true, configurable: true }); normalized ||= key !== originalKey;
  }
  if (name === 'run_command') {
    if (args.shell === undefined) args.shell = properties.shell?.enum?.[0] || (process.platform === 'win32' ? 'powershell' : 'bash');
    else if (['PowerShell', 'powershell.exe', 'bash.exe'].includes(args.shell)) { args.shell = args.shell.toLowerCase().replace(/\.exe$/, ''); normalized = true; }
  }
  if (name === 'list_files' && args.path === undefined) args.path = '.';
  if (['run_command', 'shell'].includes(name) && args.cwd === undefined) args.cwd = '.';
  if (name === 'shell' && args.args === undefined) args.args = [];
  for (const key of schema?.required || []) if (!Object.hasOwn(args, key)) throw invalid('TOOL_ARGUMENT_INVALID', 'Missing tool argument: ' + key, context);
  for (const [key, value] of Object.entries(args)) {
    const property = Object.hasOwn(properties, key) ? properties[key] : undefined;
    if (!property) continue;
    validateValue(value, property, key, context);
  }
  return { ...context, name, args, canonicalArguments: args, normalized };
}

