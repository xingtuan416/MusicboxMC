import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Documentation drifts silently. These checks keep it honest: every repo path a doc
 * mentions has to exist, every doc has to be listed in its index, the code names that
 * were removed must not come back, and the two ends of the pipeline keep their own
 * words (音轨 = MIDI input, 轨道 = laid-out track).
 */

const DOC_DIR = 'docs';
const ROOT_DOCS = ['README.md', 'AGENTS.md'];

// Documents that describe how the project behaves *today*. History documents
// (status, known-issues, the 0.4.0 plan, the changelog) may quote a removed name
// on purpose, to say that it was removed.
const CURRENT_DOCS = [
  'docs/logic-guide.md',
  'docs/constants.md',
  'docs/README.md',
  'README.md',
  'docs/README.en.md',
];

function docFiles(): string[] {
  return readdirSync(DOC_DIR)
    .filter((name) => name.endsWith('.md'))
    .map((name) => join(DOC_DIR, name).replace(/\\/g, '/'));
}

function allDocs(): string[] {
  return [...docFiles(), ...ROOT_DOCS.filter((name) => existsSync(name))];
}

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

// `src/core/layout/index.ts`, `test/fixtures/VerifyLitematic.java`, ...
const PATH_PATTERN =
  /(?<![\w/])(src|test|scripts|docs)\/[A-Za-z0-9._/-]*\.(ts|js|cjs|mjs|md|json|java|mid|litematic|nbt)/g;

// The Litematica mod sources are quoted for reference, not shipped here.
const EXTERNAL_PREFIXES = ['src/main/java/'];

function referencedPaths(text: string): string[] {
  return [...text.matchAll(PATH_PATTERN)].map((match) => match[0]);
}

describe('documentation stays in sync with the repository', () => {
  it('only mentions files that exist', () => {
    const missing: string[] = [];
    for (const doc of allDocs()) {
      for (const path of referencedPaths(read(doc))) {
        if (EXTERNAL_PREFIXES.some((prefix) => path.startsWith(prefix))) continue;
        if (!existsSync(path)) missing.push(doc + ' -> ' + path);
      }
    }
    expect(missing).toEqual([]);
  });

  it('lists every document in the documentation index', () => {
    const index = read(join(DOC_DIR, 'README.md'));
    const missing = docFiles()
      .filter((path) => !path.endsWith('docs/README.md'))
      .map((path) => path.slice('docs/'.length))
      .filter((name) => !index.includes('(' + name + ')'));
    expect(missing).toEqual([]);
  });

  it('never brings back the names of removed warnings and thresholds', () => {
    const removed = ['SMART_Z', 'SMART_WIDTH_UNRESOLVED', 'SMART_CENTER_WIDENS', 'SMART_CENTER_UNREACHED'];
    const hits: string[] = [];
    for (const doc of CURRENT_DOCS.filter((path) => existsSync(path))) {
      const text = read(doc);
      for (const name of removed) {
        const pattern = new RegExp('\\b' + name + '\\b');
        if (pattern.test(text)) hits.push(doc + ' -> ' + name);
      }
    }
    expect(hits).toEqual([]);
  });

  it('keeps one word per pipeline end (音轨 for MIDI, 轨道 for the schematic)', () => {
    const hits: string[] = [];
    for (const doc of CURRENT_DOCS.filter((path) => existsSync(path))) {
      const lines = read(doc).split('\n');
      lines.forEach((line, index) => {
        // The logic guide explains the old wording on purpose.
        if (line.startsWith('我之前在文档里把 MC 轨道写成')) return;
        if (/赛道|车道/.test(line)) hits.push(doc + ':' + (index + 1));
      });
    }
    const rendererDir = 'src/renderer';
    for (const name of readdirSync(rendererDir)) {
      if (!/\.(js|html)$/.test(name)) continue;
      const text = read(join(rendererDir, name));
      if (/赛道|车道/.test(text)) hits.push(rendererDir + '/' + name);
    }
    expect(hits).toEqual([]);
  });

  it('only mentions npm scripts that exist', () => {
    const scripts = Object.keys(JSON.parse(read('package.json')).scripts as Record<string, string>);
    const missing: string[] = [];
    for (const doc of allDocs()) {
      for (const match of read(doc).matchAll(/npm run ([a-z0-9:-]+)/g)) {
        const name = match[1]!;
        if (!scripts.includes(name)) missing.push(doc + ' -> npm run ' + name);
      }
    }
    expect(missing).toEqual([]);
  });
});
