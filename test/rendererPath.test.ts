import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { resolveRendererPath } from '../src/main/rendererPath';

const ROOT = resolve('dist/src/renderer');

/**
 * The renderer is served over a custom `app://` scheme, so this function is the only
 * thing standing between a request and the rest of the disk. It used to test
 * `target.startsWith(ROOT)`, which a sibling directory defeats.
 */
describe('app:// request paths', () => {
  it('accepts a file inside the renderer directory', () => {
    expect(resolveRendererPath(ROOT, '/main.js')).toBe(resolve(ROOT, 'main.js'));
    expect(resolveRendererPath(ROOT, '/state.js')).toBe(resolve(ROOT, 'state.js'));
  });

  it('rejects a sibling whose name merely starts with the directory name', () => {
    // Resolves to `<dist>/src/renderer-secret/secret.txt`, which `startsWith` allows
    // because "renderer-secret" begins with "renderer".
    expect(resolveRendererPath(ROOT, '/%2e%2e%5crenderer-secret%5csecret.txt')).toBeNull();
    expect(resolveRendererPath(ROOT, '/../renderer-secret/secret.txt')).toBeNull();
  });

  it('rejects a parent traversal', () => {
    expect(resolveRendererPath(ROOT, '/../package.json')).toBeNull();
    expect(resolveRendererPath(ROOT, '/%2e%2e/package.json')).toBeNull();
    expect(resolveRendererPath(ROOT, '/../../../../etc/passwd')).toBeNull();
  });

  it('rejects the directory itself', () => {
    expect(resolveRendererPath(ROOT, '/')).toBeNull();
    expect(resolveRendererPath(ROOT, '')).toBeNull();
  });

  it('rejects malformed percent-encoding instead of throwing', () => {
    expect(resolveRendererPath(ROOT, '/%')).toBeNull();
  });
});
