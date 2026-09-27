// Context capacity is independent of the model's output-token allowance.
// Providers tokenize differently, so this is a conservative local estimate,
// not a claim that the provider accepted or billed this number of tokens.
export const CONTEXT_1M_TOKENS = 1_000_000;
export const CONTEXT_SAFETY_TOKENS = 32_768;
export const CONTEXT_1M_UNSUPPORTED_MESSAGE = '当前模型或接口不支持 1M 上下文，请取消勾选「1M」后重试。';

export function normalizeContext1M(value) {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw Error('1M 上下文选项必须是布尔值');
  return value;
}

export function estimateContextTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  let ascii = 0, other = 0;
  for (const character of text) {
    if (character.codePointAt(0) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 3) + other * 2;
}

export function contextInputBudget({ outputTokens = 8192, overhead } = {}) {
  return Math.max(1, CONTEXT_1M_TOKENS - CONTEXT_SAFETY_TOKENS - outputTokens - estimateContextTokens(overhead));
}

// Only explicit capability evidence in a bounded invalid-request response can
// identify unsupported 1M context. Authentication, quota, transport failures
// and an ordinary oversized prompt cannot establish a model's context limit.
export function isContext1MUnsupported(body, { context1M = false, status, structuredError = false } = {}) {
  if (!context1M || !([400, 422].includes(status) || (status === 200 && structuredError))) return false;
  const error = body?.error;
  if (!error || typeof error !== 'object' || Array.isArray(error)) return false;
  const code = typeof error.code === 'string' ? error.code.slice(0, 128).toLowerCase() : '';
  const category = typeof error.type === 'string' ? error.type.slice(0, 128).toLowerCase() : '';
  if (/auth|api[_-]?key|permission|forbidden|quota|rate[_-]?limit|billing|credit|timeout|server[_-]?error|overloaded|payload|bytes/.test(code + ' ' + category)) return false;
  if (['context_1m_unsupported', 'context_1m_not_supported', 'context_1m_not_enabled', 'context_1m_unavailable', 'model_context_1m_unsupported'].includes(code)) return true;
  const message = typeof error.message === 'string' ? error.message.slice(0, 2048).normalize('NFKC').toLowerCase() : '';
  const contextMention = /\bcontext(?:[ _-]window)?\b|上下文/.test(message);
  if (!contextMention) return false;
  // These field names explicitly measure total context tokens, not output
  // tokens, tokens per minute, request bytes or an inferred model-name limit.
  if (['max_context_tokens', 'maximum_context_tokens', 'context_window_tokens', 'max_context_window_tokens']
    .some(key => Number.isSafeInteger(error[key]) && error[key] > 0 && error[key] < CONTEXT_1M_TOKENS)) return true;
  const maximum = /\b(?:maximum|max(?:imum)? supported)[ -]+context[ -]+(?:length|window|size)(?:[ -]+(?:is|of))?[\s:=,-]*([1-9]\d{0,2}(?:[, _]\d{3})+|[1-9]\d*)\s+tokens\b/g;
  for (const match of message.matchAll(maximum)) {
    // A requested budget is not the model's capacity, even when it uses the
    // same words. Require an explicit maximum total-context measurement.
    const before = message.slice(Math.max(0, match.index - 48), match.index);
    if (/\b(?:requested|requesting|configured|set|output|per minute|tpm|price)\b[^.!?;\n]*$/.test(before)) continue;
    const capacity = Number(match[1].replace(/[, _]/g, ''));
    if (Number.isSafeInteger(capacity) && capacity > 0 && capacity < CONTEXT_1M_TOKENS) return true;
  }
  const million = '(?:1\\s*m\\b|1[,_ ]?000[,_ ]?000\\b|1\\s+million\\b|100万|一百万)';
  const subject = '(?:' + million + '[ -]*(?:tokens?[ -]*)?(?:context(?:[ -]*window)?|上下文)|(?:context(?:[ -]*window)?|上下文)[ -]*(?:(?:of|up to)[ -]*)?' + million + '(?:[ -]*tokens?)?)';
  const unavailable = '(?:not[ -]+(?:supported|enabled|available|offered)|unsupported|unavailable|不支持|未启用|未开通)';
  const before = '(?:(?:does[ -]+not|doesn\'t|cannot|can\'t)[ -]+support|unsupported|unavailable|不支持|未启用|未开通)';
  return new RegExp(subject + '[ :,-]*(?:(?:is|are|is currently|is presently)[ -]*)?' + unavailable).test(message)
    || new RegExp(before + '[ :,-]*(?:(?:a|the|this|requested)[ -]+)?' + subject).test(message);
}

// Remove only complete protocol groups. Their drop callback releases cached
// outputs and replay IDs together, retaining lightweight execution receipts.
export function compactProtocolHistory(history, groups, prefixLength, dropped, { context1M = false, outputTokens = 8192, overhead } = {}) {
  if (!context1M) {
    // Preserve the previous policy exactly for existing and unchecked members.
    let bytes = Buffer.byteLength(JSON.stringify(history));
    while (groups.length > 1 && (groups.length > 30 || bytes > 512 * 1024)) {
      const group = groups.shift();
      history.splice(prefixLength, typeof group === 'number' ? group : group.length);
      dropped?.(group);
      bytes = Buffer.byteLength(JSON.stringify(history));
    }
    return;
  }
  const budget = contextInputBudget({ outputTokens, overhead });
  let tokens = estimateContextTokens(history);
  while (groups.length > 1 && tokens > budget) {
    const group = groups.shift();
    history.splice(prefixLength, typeof group === 'number' ? group : group.length);
    dropped?.(group);
    tokens = estimateContextTokens(history);
  }
}
