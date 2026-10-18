const { createServer } = require('node:http');
const { existsSync, readFileSync, statSync } = require('node:fs');
const { extname, join, resolve } = require('node:path');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
};

/**
 * Serve src/renderer over HTTP for the UI verification scripts.
 *
 * The renderer is split into ES modules, and Chromium refuses to load module
 * scripts from `file://`. The application itself serves them from a custom
 * `app://` scheme (see src/main/index.ts); a plain HTTP server has the same
 * effect and is far easier to drive from Playwright.
 */
function serveRenderer() {
  const root = resolve('src/renderer');
  // Files the build generates into the renderer directory - the application icon is one -
  // are not in the source tree. Serve the source first so the code under test is the code
  // being edited, and fall back to the built copy for generated assets only.
  const builtRoot = resolve('dist/src/renderer');
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const requested = join(root, pathname === '/' ? 'index.html' : pathname);
    const target =
      requested.startsWith(root) && existsSync(requested)
        ? requested
        : join(builtRoot, pathname === '/' ? 'index.html' : pathname);
    const allowed = target.startsWith(root) || target.startsWith(builtRoot);
    if (!allowed || !existsSync(target) || statSync(target).isDirectory()) {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': CONTENT_TYPES[extname(target)] ?? 'application/octet-stream',
    });
    response.end(readFileSync(target));
  });

  return new Promise((ready) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      ready({
        url: `http://127.0.0.1:${port}/index.html`,
        close: () => server.close(),
      });
    });
  });
}

module.exports = { serveRenderer };
