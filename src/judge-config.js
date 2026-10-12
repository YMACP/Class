// Jev is an optional side channel. These defaults never enable it implicitly.
export const DEFAULT_JUDGE_CONFIG = Object.freeze({
  enabled: false,
  protocol: 'system-one',
  baseUrl: 'https://api.typesafe.ai/v1/systemone',
  model: 'jev-latest',
  apiKey: '',
  timeoutMs: 1500,
  maxConcurrency: 2,
  minOutputChars: 6000,
  features: Object.freeze({ taskDispatch: false, toolCalls: false, toolResults: true, submissionReview: true }),
});

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

// Errors deliberately omit submitted values: a bad address may contain a key.
export function normalizeJudgeConfig(raw = {}, { includeSecret = true } = {}) {
  if (!object(raw)) throw Error('Jev 配置必须是对象');
  const boolean = (value, fallback) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') throw Error('Jev 开关必须是布尔值');
    return value;
  };
  const integer = (key, min, max) => {
    const value = raw[key] ?? DEFAULT_JUDGE_CONFIG[key];
    if (!Number.isSafeInteger(value) || value < min || value > max) throw Error('Jev 数值配置超出允许范围');
    return value;
  };
  // Older profiles and clients may still submit protocol/model fields. Accept
  // them for compatibility, but Jev always uses its native, fixed interface.
  const { protocol, model } = DEFAULT_JUDGE_CONFIG;
  // Older 1.1.0 profiles may contain a mode. Keep their enabled flag and
  // selected features, but never carry the removed observation mode forward.
  if (raw.mode !== undefined && !['shadow', 'active'].includes(raw.mode)) throw Error('旧版 Jev 模式无效');
  const base = raw.baseUrl ?? DEFAULT_JUDGE_CONFIG.baseUrl;
  if (typeof base !== 'string' || base.length > 2048 || !base.trim()) throw Error('Jev API 地址无效');
  const baseUrl = base.trim().replace(/\/+$/, '');
  let url;
  try { url = new URL(baseUrl); } catch { throw Error('Jev API 地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /[?#\s]/.test(baseUrl)) {
    throw Error('Jev API 地址必须为 HTTP(S)，且不能包含账号、查询参数或片段');
  }
  const apiKey = raw.apiKey ?? '';
  if (typeof apiKey !== 'string' || apiKey.length > 4096 || /[\x00-\x1f\x7f]/.test(apiKey)) throw Error('Jev API Key 格式无效');
  if (raw.features !== undefined && !object(raw.features)) throw Error('Jev 功能配置必须是对象');
  const features = Object.fromEntries(Object.entries(DEFAULT_JUDGE_CONFIG.features)
    .map(([key, fallback]) => [key, boolean(raw.features && own(raw.features, key) ? raw.features[key] : undefined, fallback)]));
  return {
    enabled: boolean(raw.enabled, false), protocol, baseUrl, model,
    apiKey: includeSecret ? apiKey.trim() : '',
    ...(!includeSecret ? { hasApiKey: Boolean(apiKey.trim()) } : {}),
    timeoutMs: integer('timeoutMs', 50, 10000),
    maxConcurrency: integer('maxConcurrency', 1, 8),
    minOutputChars: integer('minOutputChars', 1000, 1_000_000),
    features,
  };
}
