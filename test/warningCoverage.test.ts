import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A warning code has to line up in three places: declared, emitted and displayed.
 *
 * This went wrong before: `SEGMENT_HARD_CUT` and `LEAD_IN_USED` were declared in the
 * type and had translated text in the UI, but nothing anywhere emitted them - the
 * interface was promising a diagnostic the generator could never produce. TypeScript
 * cannot see that gap, so this test scans the sources and locks it down.
 */

const TYPES_FILE = 'src/core/layout/types.ts';
const RENDERER_DIR = 'src/renderer';

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function codesIn(text: string): string[] {
  return [...text.matchAll(/code: '([A-Z_]+)'/g)].map((match) => match[1]!);
}

const declared = [...new Set(codesIn(readFileSync(TYPES_FILE, 'utf8')))].sort();
const emitters = walk('src')
  .map((file) => file.replace(/\\/g, '/'))
  .filter((file) => file.endsWith('.ts') && file !== TYPES_FILE);
const emitted = new Set(emitters.flatMap((file) => codesIn(readFileSync(file, 'utf8'))));
// The renderer is split across several modules, so scan all of them rather than
// one file: the display text just has to exist somewhere in the UI.
const renderer = walk(RENDERER_DIR)
  .filter((file) => file.endsWith('.js'))
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n');

describe('warning code coverage', () => {
  it('declares at least one code', () => {
    expect(declared.length).toBeGreaterThan(0);
  });

  it('emits every declared code from at least one place in src', () => {
    const neverEmitted = declared.filter((code) => !emitted.has(code));
    expect(neverEmitted).toEqual([]);
  });

  it('never emits a code that is missing from the union', () => {
    const undeclared = [...emitted].filter((code) => !declared.includes(code));
    expect(undeclared).toEqual([]);
  });

  it('has user-facing text for every declared code', () => {
    const missingText = declared.filter((code) => !renderer.includes(`${code}:`));
    expect(missingText).toEqual([]);
  });
});
