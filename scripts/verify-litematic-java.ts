import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildLitematic, type RegionData } from '../src/core/litematic/build';

/**
 * Check the writer against the independent Java reader.
 *
 * The Java source parses the format directly and is not shared with the TypeScript. If it
 * cannot read the file, or reports a different cell, the writer is wrong even when its own
 * tests pass. Run `npm run verify:litematic`; CI installs a JDK for this step.
 */

const region: RegionData = {
  position: { x: 0, y: 0, z: 0 },
  size: { x: 2, y: 1, z: 2 },
  blocks: [
    { x: 0, y: 0, z: 0, state: { name: 'minecraft:stone' } },
    { x: 1, y: 0, z: 0, state: { name: 'minecraft:note_block', properties: { note: '7' } } },
    { x: 0, y: 0, z: 1, state: { name: 'minecraft:repeater', properties: { delay: '3' } } },
    { x: 1, y: 0, z: 1, state: { name: 'minecraft:redstone_wire', properties: { power: '0' } } },
  ],
};

const expected = [
  'Version=6',
  'MinecraftDataVersion=3700',
  'Metadata.RegionCount=1',
  'region=region_0 size=2x1x2 palette=5 bits=3 words=1 expectedWords=1',
  '  cell(0,0,0) index=0 paletteIndex=1 block=minecraft:stone',
  '  cell(1,0,0) index=1 paletteIndex=2 block=minecraft:note_block',
  '  cell(0,0,1) index=2 paletteIndex=3 block=minecraft:repeater',
  '  cell(1,0,1) index=3 paletteIndex=4 block=minecraft:redstone_wire',
];

const work = mkdtempSync(join(tmpdir(), 'musicboxmc-java-'));
const file = join(work, 'writer-check.litematic');
writeFileSync(
  file,
  buildLitematic([region], {
    name: 'java-check',
    author: 'MusicboxMC',
    description: '',
    dataVersion: 3700,
    version: 6,
  }),
);

try {
  const run = spawnSync('java', [resolve('test/fixtures/VerifyLitematic.java'), file], {
    encoding: 'utf8',
  });
  if (run.error) {
    console.error('Java is required for this check. Install a JDK and retry.');
    console.error(run.error.message);
    process.exitCode = 2;
  } else if (run.status !== 0) {
    console.error(run.stdout);
    console.error(run.stderr);
    process.exitCode = 1;
  } else {
    const missing = expected.filter((line) => !run.stdout.includes(line));
    if (missing.length > 0) {
      console.error('Java read the file without the expected structure:');
      for (const line of missing) console.error('missing: ' + line);
      console.error(run.stdout);
      process.exitCode = 1;
    } else {
      console.log('Java reader accepted the current litematic writer.');
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
