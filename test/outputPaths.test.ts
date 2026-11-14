import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { grantDirectory, normalizeFileName, resolveOutputPath } from '../src/main/outputPaths';

describe('directory grants for schematic output', () => {
  it('resolves a plain file name inside the granted directory', () => {
    const directory = resolve(tmpdir());
    const grant = grantDirectory(directory);
    expect(grant.path).toBe(directory);
    expect(resolveOutputPath({ token: grant.token, fileName: 'song' })).toBe(
      join(directory, 'song.litematic'),
    );
    expect(resolveOutputPath({ token: grant.token, fileName: 'song.litematic' })).toBe(
      join(directory, 'song.litematic'),
    );
  });

  it('rejects forged tokens, traversal, separators and Windows device names', () => {
    const grant = grantDirectory(tmpdir());
    const invalid = [
      { token: 'forged', fileName: 'song.litematic' },
      { token: grant.token, fileName: '../escape.litematic' },
      { token: grant.token, fileName: '..\\escape.litematic' },
      { token: grant.token, fileName: 'C:escape.litematic' },
      { token: grant.token, fileName: 'sub/song.litematic' },
      { token: grant.token, fileName: 'CON.litematic' },
      { token: grant.token, fileName: 'song.litematic.' },
      { token: grant.token, fileName: 'song\u0000.litematic' },
      { token: grant.token, fileName: '   ' },
    ];
    for (const target of invalid) expect(resolveOutputPath(target)).toBeNull();
    expect(resolveOutputPath(null)).toBeNull();
    expect(resolveOutputPath('C:\\song.litematic')).toBeNull();
  });

  it('normalizes the extension without accepting a path', () => {
    expect(normalizeFileName('曲目')).toBe('曲目.litematic');
    expect(normalizeFileName('song.LITEMATIC')).toBe('song.LITEMATIC');
    expect(normalizeFileName('a\\b')).toBeNull();
  });
});
