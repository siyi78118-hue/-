import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function resolveWranglerInvocation(options = {}) {
  const cwd = options.cwd || process.cwd();
  const platform = options.platform || process.platform;
  const execPath = options.execPath || process.execPath;
  const env = options.env || process.env;
  const fileExists = options.fileExists || existsSync;

  const localCli = join(cwd, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  if (fileExists(localCli)) {
    return { command: execPath, prefixArgs: [localCli], shell: false };
  }

  const configured = env.WRANGLER_CMD || (platform === 'win32'
    ? 'C:\\Users\\Administrator\\Tools\\bin\\wrangler.cmd'
    : 'wrangler');
  if (configured !== 'wrangler' && !env.WRANGLER_CMD && !fileExists(configured)) {
    return { command: 'wrangler', prefixArgs: [], shell: platform === 'win32' };
  }
  return {
    command: configured,
    prefixArgs: [],
    shell: platform === 'win32' && /\.(?:cmd|bat)$/i.test(configured)
  };
}
