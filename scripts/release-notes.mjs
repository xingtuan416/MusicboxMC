import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Build the Release body from the two maintained sources.
 *
 * `CHANGELOG.md` owns what changed; `docs/known-issues.md` owns the product limitations.
 * This avoids hand-copying both into a fourth document on every release. Download tables
 * and checksums still depend on built artifacts and are appended by the release step.
 */

const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
const version = process.argv[2] ?? pkg.version;

function section(text, start, stop) {
  const from = text.indexOf(start);
  if (from < 0) throw new Error(`missing section: ${start}`);
  const rest = text.slice(from + start.length);
  const end = rest.search(stop);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

const changelog = readFileSync(resolve('CHANGELOG.md'), 'utf8');
const knownIssues = readFileSync(resolve('docs/known-issues.md'), 'utf8');

const changes = section(changelog, `## [${version}]`, /\n## \[/);
const changesBody = changes.replace(/^[^\n]*\n+/, '').trim();
const limitations = section(knownIssues, '## 产品与游戏内已知限制', /\n## 后续处理建议/);

console.log(`# MusicboxMC ${version}`);
console.log('');
console.log('## 本版变更');
console.log('');
console.log(changesBody);
console.log('');
console.log('## 已知限制');
console.log('');
console.log(limitations);
