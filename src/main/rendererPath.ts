import { isAbsolute, relative, resolve } from 'node:path';

/**
 * Resolve a request path against the renderer directory, or null when it escapes.
 *
 * A `startsWith` test is not a directory boundary. A sibling directory whose name begins
 * with the same characters - `renderer-secret` next to `renderer` - passes it, and
 * `app://musicbox/%2e%2e%5crenderer-secret%5csecret.txt` resolves straight into it. The
 * path is therefore resolved first and then compared as a relative path, which is the
 * check that actually holds.
 *
 * The relative form also rejects an absolute result, and a path that resolves to the
 * directory itself, which is not a file to serve.
 */
export function resolveRendererPath(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // Malformed percent-encoding.
    return null;
  }

  const target = resolve(root, `.${decoded}`);
  const inside = relative(root, target);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return null;
  return target;
}
