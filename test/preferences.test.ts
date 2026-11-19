import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  mergePreferences,
  readPreferences,
  writePreferences,
  type Preferences,
} from '../src/main/preferences';

const made: string[] = [];

function tempFile(name = 'preferences.json'): string {
  const folder = mkdtempSync(join(tmpdir(), 'musicboxmc-prefs-'));
  made.push(folder);
  return join(folder, name);
}

afterEach(() => {
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true });
});

describe('preferences', () => {
  it('starts from the defaults when the file has never been written', () => {
    // A fresh profile: the folder dialog has no memory and the reminder is still on.
    expect(readPreferences(tempFile())).toEqual(DEFAULT_PREFERENCES);
  });

  it('reads back what it wrote, including a folder with spaces', () => {
    const file = tempFile();
    const saved: Preferences = { lastOutputDir: 'D:/我的 音乐/schematics', packPromptMuted: true };
    writePreferences(file, saved);
    expect(readPreferences(file)).toEqual(saved);
  });

  it('creates the profile folder on the way', () => {
    const file = join(tempFile(), 'nested', 'deeper', 'preferences.json');
    writePreferences(file, { lastOutputDir: null, packPromptMuted: true });
    expect(readPreferences(file).packPromptMuted).toBe(true);
  });

  it('falls back to the defaults when the file is not valid JSON', () => {
    // The file is editable by hand, and a half-saved one must not stop the window.
    const file = tempFile();
    writeFileSync(file, '{ "lastOutputDir": ', 'utf8');
    expect(readPreferences(file)).toEqual(DEFAULT_PREFERENCES);
  });

  it('ignores keys and types it does not know', () => {
    const base: Preferences = { lastOutputDir: 'C:/a', packPromptMuted: false };
    const merged = mergePreferences(base, { lastOutputDir: 42, packPromptMuted: 'yes', extra: true });
    expect(merged).toEqual(base);
  });

  it('clears the folder when the patch says null', () => {
    const base: Preferences = { lastOutputDir: 'C:/a', packPromptMuted: true };
    expect(mergePreferences(base, { lastOutputDir: null }).lastOutputDir).toBeNull();
  });

  it('keeps the other value when a patch only carries one', () => {
    const base: Preferences = { lastOutputDir: 'C:/a', packPromptMuted: false };
    expect(mergePreferences(base, { packPromptMuted: true })).toEqual({
      lastOutputDir: 'C:/a',
      packPromptMuted: true,
    });
  });

  it('treats a non-object patch as no change', () => {
    const base: Preferences = { lastOutputDir: 'C:/a', packPromptMuted: false };
    expect(mergePreferences(base, null)).toEqual(base);
    expect(mergePreferences(base, ['C:/b'])).toEqual(base);
  });
});
