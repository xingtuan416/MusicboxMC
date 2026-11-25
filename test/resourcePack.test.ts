import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

async function loadBundledPack() {
  const { inspectPack, readZipEntries } = await import('../scripts/check-piano-pack.mjs');
  const entries = readZipEntries(readFileSync('assets/musicboxmc-piano-pack-1.20.4.zip'));
  return { inspectPack, entries };
}

describe('bundled piano pack', () => {
  it('replaces only the five piano slots and rejects extra note-block events', async () => {
    const { inspectPack, entries } = await loadBundledPack();
    const result = inspectPack(entries);
    expect(result.complete).toBe(true);
    expect(result.unexpectedNoteBlockEvents).toEqual([]);
    const path = 'assets/minecraft/sounds.json';
    const sounds = JSON.parse(entries.get(path).toString('utf8'));
    sounds['block.note_block.bit'] = sounds['block.note_block.harp'];
    entries.set(path, Buffer.from(JSON.stringify(sounds)));
    expect(inspectPack(entries)).toMatchObject({
      complete: false,
      unexpectedNoteBlockEvents: ['block.note_block.bit'],
    });
  });

  it('fails when the pack format does not match the target', async () => {
    const { inspectPack, entries } = await loadBundledPack();
    entries.set('pack.mcmeta', Buffer.from(JSON.stringify({ pack: { pack_format: 1 } })));
    expect(inspectPack(entries)).toMatchObject({
      complete: false,
      versionCompatibleWithProject: false,
    });
  });
});
