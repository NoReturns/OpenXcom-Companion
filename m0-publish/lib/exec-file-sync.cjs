'use strict';

const { execFileSync } = require('node:child_process');

/**
 * execFileSync with windowsHide on Win32 so gh/PowerShell do not flash console windows (M1-25F).
 */
function execFileSyncHidden(file, args, options = {}, execImpl = execFileSync) {
  const opts = { ...options };
  if (process.platform === 'win32') {
    opts.windowsHide = true;
  }
  return execImpl(file, args, opts);
}

module.exports = {
  execFileSyncHidden,
};
