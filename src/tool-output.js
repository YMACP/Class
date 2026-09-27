// Tool summaries remain valid JSON even when strings expand during escaping.
export function boundedJson(value, limit = 65536) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) <= limit) return { output: text, truncated: false };
  const minimal = '{"truncated":true}';
  if (Buffer.byteLength(minimal) > limit) return { output: limit >= 2 ? '{}' : '0', truncated: true };
  let low = 0, high = text.length, output = minimal;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    let end = middle;
    if (end && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    const candidate = JSON.stringify({ truncated: true, preview: text.slice(0, end) });
    if (Buffer.byteLength(candidate) <= limit) { output = candidate; low = middle + 1; }
    else high = middle - 1;
  }
  return { output, truncated: true };
}

export function utf8Prefix(value, maxBytes) {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return value;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

// Class pauses are not execution time. Clearing this timer also detaches its
// listener, so completed operations do not accumulate lifetime hooks.
export function activeTimeout(manager, milliseconds, callback) {
  let remaining = milliseconds, started = 0, timer, done = false;
  const refresh = () => {
    if (done) return;
    if (timer) { clearTimeout(timer); timer = undefined; remaining -= performance.now() - started; }
    if (!manager.paused) {
      started = performance.now();
      timer = setTimeout(() => { cleanup(); callback(); }, Math.max(0, remaining));
    }
  };
  const cleanup = () => { done = true; clearTimeout(timer); timer = undefined; manager.events?.off('change', refresh); };
  manager.events?.on('change', refresh);
  refresh(); return cleanup;
}
