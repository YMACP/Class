import path from 'node:path';
import os from 'node:os';

function settings(options = {}) {
  const platform = options.platform ?? process.platform;
  return { platform, env: options.env ?? process.env, home: options.home ?? os.homedir(), paths: platform === 'win32' ? path.win32 : path.posix };
}

function xdgDirectory(value, fallback) {
  // The XDG specification requires absolute values; relative values are ignored.
  return typeof value === 'string' && path.posix.isAbsolute(value) ? value : fallback;
}

export function defaultDataDirectory(options) {
  const { platform, env, home, paths } = settings(options);
  if (platform === 'linux') return paths.join(xdgDirectory(env.XDG_DATA_HOME, paths.join(home, '.local', 'share')), 'class');
  return paths.join(env.LOCALAPPDATA || paths.join(home, 'AppData', 'Local'), 'discussion');
}

export function defaultStartupLogDirectory(options) {
  const { platform, env, home, paths } = settings(options);
  if (platform === 'linux') return paths.join(xdgDirectory(env.XDG_STATE_HOME, paths.join(home, '.local', 'state')), 'class', 'logs');
  return paths.join(env.LOCALAPPDATA || paths.join(home, 'AppData', 'Local'), 'Class', 'logs');
}

export function startupLogDirectory(dataDir, options) {
  const { platform, paths } = settings(options);
  // Custom and relocated profiles retain their own startup log, as on Windows.
  if (platform === 'linux' && paths.resolve(dataDir) === paths.resolve(defaultDataDirectory(options))) return defaultStartupLogDirectory(options);
  return dataDir;
}
