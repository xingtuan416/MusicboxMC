const { chromium } = require('playwright-core');
const { mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { Midi } = require('@tonejs/midi');
const { generate } = require('./fresh-dist.cjs').requireFreshService();
const { serveRenderer } = require('./serve-renderer.cjs');

/**
 * Walk the real interface through all eight steps against real generator output.
 *
 * The point is not the pictures. `window.musicbox` is stubbed with a genuine
 * `AnalyzeResult`/`GenerateResult` from the actual service, so every number the interface
 * shows is a number it derived itself - which is what catches a wrong element id, a
 * discarded field, or a step that cannot be reached.
 */
function buildSource(directory) {
  const midi = new Midi();
  midi.header.setTempo(120);

  // Track names are ASCII on purpose: @tonejs/midi writes text as the low byte of each
  // UTF-16 unit, so a Chinese name comes back as unrecoverable noise. That is the
  // library's limitation, not the parser's, and the GBK path is covered by unit tests
  // with real byte fixtures - so a fixture here must not pretend otherwise.
  const melody = midi.addTrack();
  melody.name = 'Melody';
  melody.instrument.name = 'acoustic grand piano';
  const tune = [72, 74, 76, 79, 76, 74, 72, 69, 71, 72, 76, 74, 72, 71, 69, 67];
  tune.forEach((pitch, i) => melody.addNote({ midi: pitch, time: i * 0.5, duration: 0.45 }));

  const bass = midi.addTrack();
  bass.name = 'Bass';
  bass.instrument.name = 'electric bass (finger)';
  for (let i = 0; i < 8; i++) bass.addNote({ midi: 36 + (i % 4) * 2, time: i, duration: 0.9 });

  // One note far above the range, so the "needs attention" line has something real in it.
  // Eight notes at once, so the layout has to use branch rows. That is what spreads the
  // tracks apart in Z, and it is the case the preview has to stay navigable in.
  const high = midi.addTrack();
  high.name = 'Chords';
  high.instrument.name = 'celesta';
  for (const pitch of [84, 86, 88, 89, 91, 93, 95, 96]) {
    high.addNote({ midi: pitch, time: 2, duration: 0.5 });
  }
  high.addNote({ midi: 108, time: 3, duration: 0.5 });

  const path = join(directory, 'ui-check.mid');
  writeFileSync(path, Buffer.from(midi.toArray()));
  return path;
}

(async () => {
  const directory = join(tmpdir(), `musicbox-ui-${Date.now()}`);
  mkdirSync(directory, { recursive: true });
  const source = buildSource(directory);

  const analyze = generate(source, { dMax: 6 });
  if (!analyze.result.success) throw new Error(analyze.result.error);
  const result = {
    ...analyze.result,
    path: source,
    outputPath: join(directory, 'ui-check.litematic'),
    outputDir: directory,
  };
  console.log(
    `fixture: ${result.song.noteCount} notes, ${result.tracks.length} tracks, ` +
      `${result.stats.noteBlockCount + result.stats.circuitBlocks} blocks, ` +
      `${result.outOfRangeNotes} out of range`,
  );

  mkdirSync(resolve('out/ui-shots'), { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const site = await serveRenderer();
  const problems = [];

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 940 }, deviceScaleFactor: 1.5 });
    page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(`console: ${message.text()}`);
    });
    // A bare console message says a request failed but not which one.
    page.on('response', (response) => {
      if (response.status() >= 400) problems.push(`HTTP ${response.status()} ${response.url()}`);
    });

    await page.addInitScript((fixture) => {
      window.__calls = [];
      window.musicbox = {
        onLog() {},
        chooseMidi: async () => fixture.path,
        analyze: async () => fixture,
        generate: async () => fixture,
        chooseDirectory: async () => fixture.outputDir,
        saveResourcePack: async () => {
          window.__calls.push('saveResourcePack');
          return 'C:/tmp/musicboxmc-piano-pack.zip';
        },
        appInfo: async () => ({
          name: 'MusicboxMC',
          version: '0.2.0',
          license: 'GPL-3.0-or-later',
          repository: 'https://github.com/xingtuan416/MusicboxMC',
          author: 'xingtuan416',
        }),
        reveal: async (p) => {
          window.__calls.push('reveal ' + p);
        },
        open: async () => {},
        pathForFile: () => fixture.path,
        windowControl: async () => {},
      };
    }, result);

    await page.goto(site.url);
    await page.waitForTimeout(400);

    const shot = async (name) => {
      await page.waitForTimeout(320);
      await page.screenshot({ path: resolve(`out/ui-shots/${name}.png`) });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      if (overflow) problems.push(`${name}: horizontal overflow`);
    };

    await shot('1-start');

    // Step 1 -> 2, then pick a file through the dialog the renderer asks for.
    await page.locator('#step-1 [data-goto="2"]').click();
    await page.locator('#importEmpty').click();
    await page.waitForFunction(() => document.getElementById('importLoaded').style.display === 'flex');
    await shot('2-import-loaded');

    const shown = await page.evaluate(() => ({
      title: document.getElementById('midiFileTitle').textContent,
      notes: document.getElementById('valNotes').textContent,
      tracks: document.getElementById('valTracks').textContent,
    }));
    if (shown.notes !== result.song.noteCount.toLocaleString('en-US')) {
      problems.push(`imported note count shows ${shown.notes}`);
    }

    await page.locator('#btnStep2Next').click();
    await page.waitForTimeout(200);
    const trackRows = await page.locator('[data-track-idx]').count();
    if (trackRows !== result.tracks.length) {
      problems.push(`track list shows ${trackRows} rows, expected ${result.tracks.length}`);
    }
    await shot('3-tracks');

    await page.locator('#btnStep3Next').click();
    await page.locator('[data-fold="fold-pitch"]').click();
    await shot('4-config');

    // Every fold open is the tallest this step gets, and its own buttons must stay
    // reachable. Clicking proves nothing: an element clipped by its container still
    // reports itself as visible, so this compares geometry after scrolling instead.
    for (const fold of await page.locator('#step-4 [data-fold]').all()) await fold.click();
    await page.waitForTimeout(320);
    await page.evaluate(() => {
      const step = document.getElementById('step-4');
      step.scrollTop = step.scrollHeight;
    });
    await page.waitForTimeout(200);

    const reach = await page.evaluate(() => {
      const step = document.getElementById('step-4');
      const button = step.querySelector('.action-bar button:last-child');
      const container = step.getBoundingClientRect();
      const box = button.getBoundingClientRect();
      return {
        inside: box.bottom <= container.bottom + 1 && box.top >= container.top - 1,
        scrollable: step.scrollHeight > step.clientHeight,
        overflow: step.scrollHeight - step.clientHeight,
      };
    });
    if (!reach.scrollable) problems.push('step 4 does not overflow, so this check proved nothing');
    if (!reach.inside) {
      problems.push(`step 4 action bar is out of reach (overflow ${reach.overflow}px)`);
    }
    await shot('4-config-all-open');

    await page.locator('#step-4 [data-goto="5"]').click();

    // Exporting needs somewhere to export to, so the button waits for a location.
    if (!(await page.locator('#btnStartGen').isDisabled())) {
      problems.push('step 5 lets the user generate before choosing a location');
    }
    await page.locator('#btnChooseOutput').click();
    if (await page.locator('#btnStartGen').isDisabled()) {
      problems.push('step 5 keeps 开始生成投影 disabled after a location is chosen');
    }

    // The resource pack is offered here, at the export step, and has to reach the API.
    await page.locator('#btnSavePack').click();
    const calls = await page.evaluate(() => window.__calls);
    if (!calls.includes('saveResourcePack')) {
      problems.push('保存资源包 did not call saveResourcePack');
    }
    if (!calls.some((call) => call.startsWith('reveal '))) {
      problems.push('保存资源包 did not reveal the saved file');
    }
    await shot('5-output');

    await page.locator('#btnStartGen').click();

    // Step 6 rehearses: it generates without writing, then shows what it found.
    await page.waitForFunction(() => document.getElementById('step-6').classList.contains('active'), {
      timeout: 40000,
    });
    await page.waitForFunction(() => document.querySelectorAll('#issueList .issue').length > 0, {
      timeout: 40000,
    });

    const canvas = await page.evaluate(() => {
      const element = document.getElementById('canvas');
      return { width: element.width, height: element.height };
    });
    if (!canvas.width || !canvas.height) {
      problems.push(`the redstone preview never drew (${canvas.width}x${canvas.height})`);
    }
    if (await page.locator('#previewZoomIn').count()) {
      problems.push('a zoom control is back, but the preview is meant to be one fixed scale');
    }

    // Panning replaced zooming, so the wheel has to move the drawing sideways. The hint
    // line carries the visible cell range, which is the cheapest proof that it moved.
    const panBefore = await page.evaluate(() => document.getElementById('previewHint').textContent);
    await page.locator('#canvasWrap').hover();
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(260);
    const panAfter = await page.evaluate(() => document.getElementById('previewHint').textContent);
    if (panBefore === panAfter) problems.push('the wheel did not pan the preview');
    // A chip per track, and it has to actually reach the row: dragging to find a track is
    // what this replaced.
    const chips = await page.locator('#previewTrackChips .pill-tag').count();
    if (chips < 2) {
      problems.push(`expected a jump chip per track, found ${chips}`);
    }
    const beforeChip = await page.evaluate(() => document.getElementById('previewHint').textContent);
    await page.locator('#previewTrackChips .pill-tag').last().click();
    await page.waitForTimeout(280);
    const afterChip = await page.evaluate(() => document.getElementById('previewHint').textContent);
    if (beforeChip === afterChip) problems.push('a track chip did not move the preview');
    await shot('6-check');

    // A short window puts the next-step button below the fold. The step must say so, or it
    // reads as a dead end; a tall window must not show the hint at all.
    await page.setViewportSize({ width: 1180, height: 620 });
    await page.waitForTimeout(400);
    const shortState = await page.evaluate(() => {
      const hint = document.getElementById('scrollHint');
      const button = document.getElementById('btnGoGenerate');
      const screen = document.getElementById('step-6');
      if (!hint || !button || !screen) return null;
      const rect = button.getBoundingClientRect();
      return {
        hintHidden: hint.hidden,
        hintRendered: hint.getBoundingClientRect().height > 0,
        buttonBelowFold: rect.top > screen.getBoundingClientRect().bottom - 4,
      };
    });
    if (!shortState) {
      problems.push('scroll hint: elements missing from the check step');
    } else {
      if (!shortState.buttonBelowFold) {
        problems.push('scroll hint: the test window was not short enough to test it');
      }
      if (shortState.hintHidden || !shortState.hintRendered) {
        problems.push('scroll hint: not shown although the next button is below the fold');
      }
    }
    await page.screenshot({ path: resolve('out/ui-shots/6-check-short.png') });

    await page.setViewportSize({ width: 1440, height: 940 });
    // The check step is tall at any window size - issues, canvas, footer, action bar - so
    // the button only comes into view once the step is scrolled to the bottom.
    await page.evaluate(() => {
      const screen = document.getElementById('step-6');
      if (screen) screen.scrollTop = screen.scrollHeight;
    });
    await page.waitForTimeout(600);
    const tallHidden = await page.evaluate(() => document.getElementById('scrollHint')?.hidden);
    if (tallHidden !== true) {
      problems.push('scroll hint: still shown after scrolling the next button into view');
    }

    // Chromium ignores ::-webkit-scrollbar as soon as scrollbar-width is set, which is why
    // some surfaces kept the default grey bar. Nothing may set it.
    const scrollbarWidth = await page.evaluate(() => {
      const wrap = document.getElementById('canvasWrap');
      return wrap ? getComputedStyle(wrap).scrollbarWidth : null;
    });
    if (scrollbarWidth !== 'auto' && scrollbarWidth !== '') {
      problems.push(
        'scrollbars: scrollbar-width is set to ' + scrollbarWidth + ', which overrides the custom style',
      );
    }

    // Only this button writes a file.
    await page.locator('#btnGoGenerate').click();
    await page.waitForFunction(() => document.getElementById('step-8').classList.contains('active'), {
      timeout: 60000,
    });
    // A first export that wrote a file explains the optional pack, exactly once, and the
    // dialog has to actually be visible: the stylesheet hides a backdrop without `open`.
    const nudges = await page.locator('.modal-backdrop.open').count();
    if (nudges !== 1) problems.push(`expected one resource-pack nudge, found ${nudges}`);
    await page.waitForTimeout(260);
    await page.screenshot({ path: resolve('out/ui-shots/8-pack-nudge.png') });

    await page.getByRole('button', { name: '以后再说' }).click();
    await page.waitForTimeout(200);
    if (await page.locator('.modal-backdrop.open').count()) {
      problems.push('the resource-pack nudge did not close');
    }

    await shot('7-done');

    const done = await page.evaluate(() => ({
      blocks: document.getElementById('doneBlocks').textContent,
      dims: document.getElementById('doneDims').textContent,
      size: document.getElementById('doneSize').textContent,
      warn: document.getElementById('doneWarningBox').textContent,
      trigger: document.getElementById('doneTriggerHint').textContent,
    }));
    console.log('done page:', JSON.stringify(done, null, 1));

    // Nothing may claim a value it did not compute.
    if (done.blocks === '—' || done.dims === '—' || done.size === '—') {
      problems.push('the result page left a statistic unfilled');
    }

    // A narrow pass, since a frameless window can be resized very small.
    await page.setViewportSize({ width: 900, height: 900 });
    await page.locator('#step-8').scrollIntoViewIfNeeded();
    await shot('7-done-narrow');

    console.log(problems.length ? `PROBLEMS:\n${problems.join('\n')}` : 'no console errors, no overflow');
  } finally {
    site.close();
    await browser.close();
    rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
