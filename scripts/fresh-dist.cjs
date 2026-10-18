'use strict';

const { existsSync, readdirSync, statSync } = require('node:fs');
const { join, resolve } = require('node:path');

const root = resolve(__dirname, '..');

function newestMtime(dir) {
  let newest = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else newest = Math.max(newest, statSync(full).mtimeMs);
    }
  };
  walk(dir);
  return newest;
}

/**
 * Load the main-process service, but refuse to run against a stale dist.
 *
 * These verification scripts used to `require('../dist/...')` without ever building,
 * so it happened that src had been rewritten to the frame-table implementation while
 * dist still held the per-note one, and the verification was all green - the old build
 * produced a 348KB / 46k-command-block schematic and nobody noticed. This compares the
 * mtimes of src and dist first and fails loudly when dist is older, instead of silently
 * verifying old code.
 */
function requireFreshService() {
  const distSrc = join(root, 'dist', 'src');
  if (!existsSync(distSrc)) {
    throw new Error('dist 不存在，请先运行 npm run build 再执行验证脚本。');
  }
  const srcTime = newestMtime(join(root, 'src'));
  const distTime = newestMtime(distSrc);
  if (distTime < srcTime) {
    throw new Error(
      `dist 比 src 旧（相差 ${((srcTime - distTime) / 1000).toFixed(1)}s），` +
        '验证会跑到过时代码上。请先运行 npm run build。',
    );
  }
  return require(join(distSrc, 'main', 'service'));
}

module.exports = { requireFreshService };
