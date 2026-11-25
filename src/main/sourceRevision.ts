import { statSync } from 'node:fs';

export function sourceRevision(path: string, expected?: string): string {
  const stat = statSync(path, { bigint: true, throwIfNoEntry: false });
  if (!stat) throw new Error(expected ? 'MIDI 文件已变化，请返回导入页重新导入。' : 'MIDI 文件不存在。');
  const { dev, ino, size, mtimeNs, ctimeNs } = stat;
  const revision = [dev, ino, size, mtimeNs, ctimeNs].join(':');
  if (expected !== undefined && revision !== expected) {
    throw new Error('MIDI 文件已变化，请返回导入页重新导入。');
  }
  return revision;
}
