import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { OutputGrant } from './types';

interface SelectedOutput {
  path: string;
  token: string;
  revision: string | null;
}

const GRANT_LIMIT = 64;
const grants = new Map<string, SelectedOutput>();

const INVALID_FILE_CHARS = /[<>:"/\\|?*]/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
const MAX_FILE_NAME = 180;

export class OutputSelectionChanged extends Error {
  constructor() {
    super('保存位置的文件已变化，请重新选择保存位置。');
  }
}

function destinationRevision(path: string): string | null {
  const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile()) throw new OutputSelectionChanged();
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

/** Authorize exactly the path returned by the native Save As dialog. */
export function grantOutput(path: string): OutputGrant {
  const name = basename(path);
  if (!isAbsolute(path) || normalizeFileName(name) !== name) {
    throw new Error('请选择有效的 .litematic 文件名。');
  }
  const revision = destinationRevision(path);
  const token = randomUUID();
  grants.set(token, { path, token, revision });
  if (grants.size > GRANT_LIMIT) {
    const oldest = grants.keys().next().value;
    if (oldest !== undefined) grants.delete(oldest);
  }
  return { path, token };
}

export function resolveOutput(target: unknown): SelectedOutput | undefined {
  return typeof target === 'string' ? grants.get(target) : undefined;
}

/** Publish once, using overwrite permission only for the file the dialog confirmed. */
export function writeSelectedOutput(target: SelectedOutput, bytes: Uint8Array): void {
  try {
    writeSchematic(target.path, bytes, target.revision !== null, () => {
      if (grants.get(target.token) !== target || destinationRevision(target.path) !== target.revision) {
        throw new OutputSelectionChanged();
      }
    });
    grants.delete(target.token);
  } catch (error) {
    if (error instanceof OutputSelectionChanged || (error as NodeJS.ErrnoException).code === 'EEXIST') {
      grants.delete(target.token);
      throw new OutputSelectionChanged();
    }
    throw error;
  }
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

/** Publish a complete file. An unconfirmed write must fail if another writer wins the name. */
export function writeSchematic(
  file: string,
  bytes: Uint8Array,
  replace = false,
  beforePublish?: () => void,
): void {
  const temp = join(dirname(file), '.' + randomUUID() + '.litematic.tmp');
  const fd = openSync(temp, 'wx');
  try {
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    beforePublish?.();
    if (replace) renameSync(temp, file);
    else linkSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}
