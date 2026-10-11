import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 告警码的"声明 / 发出 / 展示"三处必须对齐。
 *
 * 历史问题：`SEGMENT_HARD_CUT` 与 `LEAD_IN_USED` 在类型里声明、在界面上写了
 * 文案，但全仓库没有任何一处发出它们 —— 界面等于在承诺一个生成器永远给不出
 * 的诊断。TypeScript 看不到这种缺口，所以这里直接扫描源码把它锁住。
 */

const TYPES_FILE = 'src/core/layout/types.ts';
const RENDERER_FILE = 'src/renderer/app.js';

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
const renderer = readFileSync(RENDERER_FILE, 'utf8');

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
