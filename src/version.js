import packageInfo from '../package.json' with { type: 'json' };

export const VERSION = typeof CLASS_DESKTOP_VERSION === 'string' ? CLASS_DESKTOP_VERSION : packageInfo.version;
export const COMPILED_DESKTOP = typeof CLASS_DESKTOP_COMPILED !== 'undefined' && CLASS_DESKTOP_COMPILED === true;
