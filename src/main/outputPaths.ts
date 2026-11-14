import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { DirectoryGrant, OutputTarget } from './types';

/**
 * Directory grants for schematic output.
 *
 * The renderer never receives write authority as a free-form path. It gets an opaque token
 * for a directory the user chose through the native dialog, plus permission to supply one
 * plain file name inside it. Tokens live only for this process, so a stale renderer path
 * cannot be replayed after a restart.
 */

const GRANT_LIMIT = 64;
const grants = new Map<string, string>();

const INVALID_FILE_CHARS = /[<>:"/\\|?*]/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
const MAX_FILE_NAME = 180;

/** Record a directory the user picked, and return the display path plus its token. */
export function grantDirectory(directory: string): DirectoryGrant {
  const path = resolve(directory);
  const token = randomUUID();
  grants.set(token, path);
  while (grants.size > GRANT_LIMIT) {
    const oldest = grants.keys().next().value;
    if (oldest === undefined) break;
    grants.delete(oldest);
  }
  return { path, token };
}

/**
 * Resolve a renderer output request to an absolute path, or null when it is not authorized.
 *
 * The file name is deliberately narrower than a path: no separators, drive letters,
 * alternate data streams, traversal, Windows device names, or trailing dots/spaces.
 */
export function resolveOutputPath(target: unknown): string | null {
  if (target === null || typeof target !== 'object' || Array.isArray(target)) return null;
  const candidate = target as Partial<OutputTarget>;
  if (typeof candidate.token !== 'string' || typeof candidate.fileName !== 'string') return null;
  const directory = grants.get(candidate.token);
  if (!directory) return null;

  const fileName = normalizeFileName(candidate.fileName);
  if (!fileName) return null;

  const output = resolve(directory, fileName);
  const inside = relative(directory, output);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return null;
  return inside === fileName ? join(directory, fileName) : null;
}

/** Add the litematic extension and reject anything that could escape the granted folder. */
export function normalizeFileName(raw: string): string | null {
  let name = raw.trim();
  if (!name || name.length > MAX_FILE_NAME) return null;
  if (INVALID_FILE_CHARS.test(name) || name.endsWith('.') || name.endsWith(' ')) return null;
  for (const char of name) if (char.charCodeAt(0) < 32) return null;
  if (!name.toLowerCase().endsWith('.litematic')) name = `${name}.litematic`;
  const stem = name.slice(0, -'.litematic'.length);
  if (!stem || stem === '.' || stem === '..' || WINDOWS_RESERVED.test(stem)) return null;
  return name;
}
