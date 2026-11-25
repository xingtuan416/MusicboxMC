import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  grantOutput,
  normalizeFileName,
  OutputSelectionChanged,
  resolveOutput,
  writeSelectedOutput,
} from '../src/main/outputPaths';

function withOutput(run: (file: string, folder: string) => void): void {
  const folder = mkdtempSync(join(tmpdir(), 'musicbox-save-'));
  try {
    run(join(folder, 'song.litematic'), folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

describe('native Save As target', () => {
  it('only authorizes the exact path selected and consumes the token after saving', () => {
    withOutput((file) => {
      const grant = grantOutput(file);
      expect(grant.path).toBe(file);
      const selected = resolveOutput(grant.token);
      expect(selected?.path).toBe(file);
      expect(resolveOutput({ token: grant.token, fileName: 'another.litematic' })).toBeUndefined();
      expect(resolveOutput(file)).toBeUndefined();
      expect(resolveOutput('forged')).toBeUndefined();

      writeSelectedOutput(selected!, Buffer.from('schematic'));
      expect(readFileSync(file, 'utf8')).toBe('schematic');
      expect(resolveOutput(grant.token)).toBeUndefined();
    });
  });

  it('does not overwrite a file created after the dialog accepted a new path', () => {
    withOutput((file, folder) => {
      const { token } = grantOutput(file);
      const selected = resolveOutput(token);
      writeFileSync(file, 'new arrival');
      expect(() => writeSelectedOutput(selected!, Buffer.from('schematic'))).toThrow(OutputSelectionChanged);
      expect(readFileSync(file, 'utf8')).toBe('new arrival');
      expect(readdirSync(folder)).toEqual(['song.litematic']);
      expect(resolveOutput(token)).toBeUndefined();
    });
  });

  it('overwrites the confirmed file and rejects a later change to that file', () => {
    withOutput((file) => {
      writeFileSync(file, 'old export');
      const initial = grantOutput(file);
      writeFileSync(file, 'updated while generating');
      expect(() => writeSelectedOutput(resolveOutput(initial.token)!, Buffer.from('next'))).toThrow(
        OutputSelectionChanged,
      );
      expect(readFileSync(file, 'utf8')).toBe('updated while generating');
      const confirmed = grantOutput(file);
      writeSelectedOutput(resolveOutput(confirmed.token)!, Buffer.from('next'));
      expect(readFileSync(file, 'utf8')).toBe('next');
    });
  });

  it('validates native selections without rewriting the filename after confirmation', () => {
    withOutput((_file, folder) => {
      for (const name of ['song', 'song.txt', 'CON.litematic', 'song.litematic.', ' song.litematic']) {
        expect(() => grantOutput(join(folder, name))).toThrow('.litematic');
      }
    });
  });

  it('normalizes the default suggestion without accepting a path', () => {
    expect(normalizeFileName('曲目')).toBe('曲目.litematic');
    expect(normalizeFileName('song.LITEMATIC')).toBe('song.LITEMATIC');
    for (const name of ['../escape.litematic', 'C:escape.litematic', 'a\\b', 'song\u0000.litematic']) {
      expect(normalizeFileName(name)).toBeNull();
    }
  });
});
