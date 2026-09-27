import { boundedJson } from './tool-output.js';
const member = { type: 'string', minLength: 1, description: 'Member ID to inspect, or all. Defaults to yourself. Updates only affect your own plan/todos.' };
export const isPlanningTool = name => ['plan_read', 'plan_write', 'todo_read', 'todo_write'].includes(name);
const define = (name, description, properties, required = []) => ({ name, description, parameters: { type: 'object', properties, required, additionalProperties: false } });
export const planningToolDefinitions = [
  define('plan_read', 'Read a member plan (or all plans). Plans are working notes, not approvals or evidence of completion.', { member }),
  define('plan_write', 'Replace your working plan. This never changes the Class workflow, pauses teammates, or submits an answer.', { content: { type: 'string', maxLength: 16000 } }, ['content']),
  define('todo_read', 'Read a member todo list (or all lists). Todo status is self-reported, not teacher acceptance.', { member }),
  define('todo_write', 'Replace your todo list. Use stable unique IDs and preserve completed work. This does not dispatch tasks or finish the Class task.', {
    todos: { type: 'array', maxItems: 100, items: { type: 'object', properties: {
      id: { type: 'string', minLength: 1, maxLength: 100 }, content: { type: 'string', minLength: 1, maxLength: 2000 },
      status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked'] },
    }, required: ['id', 'content', 'status'], additionalProperties: false } },
  }, ['todos']),
];

export async function executePlanningTool(manager, studentId, name, args, signal) {
  await manager.checkpoint(signal);
  const store = manager.planningState;
  const current = store.get(studentId) ?? { member: studentId, plan: '', todos: [], revision: 0 };
  if (name === 'plan_write') {
    if (typeof args.content !== 'string' || args.content.length > 16000) throw Error('Plan must be a string of at most 16000 characters');
    store.set(studentId, { ...current, plan: args.content, revision: current.revision + 1 });
  } else if (name === 'todo_write') {
    if (!Array.isArray(args.todos) || args.todos.length > 100) throw Error('todos must be an array of at most 100 items');
    const ids = new Set();
    for (const item of args.todos) {
      if (!item || typeof item.id !== 'string' || !item.id.trim() || item.id.length > 100 || ids.has(item.id)
        || typeof item.content !== 'string' || !item.content.trim() || item.content.length > 2000
        || !['pending', 'in_progress', 'completed', 'blocked'].includes(item.status)) throw Error('Invalid todo item or duplicate todo ID');
      ids.add(item.id);
    }
    store.set(studentId, { ...current, todos: args.todos.map(({ id, content, status }) => ({ id, content, status })), revision: current.revision + 1 });
  } else if (!['plan_read', 'todo_read'].includes(name)) throw Error('Unknown planning tool');
  const target = name.endsWith('_write') ? studentId : args.member ?? studentId;
  const values = target === 'all' ? [...store.values()] : [store.get(target) ?? { member: target, plan: '', todos: [], revision: 0 }];
  const entries = values.map(value => ({ member: value.member, revision: value.revision, ...(name.startsWith('plan_') ? { plan: value.plan } : { todos: value.todos }) }));
  // Never truncate a JSON envelope. Return an explicit smaller-query hint instead.
  return { name, ...boundedJson({ entries, selfReported: true }, manager.maxOutputBytes) };
}
