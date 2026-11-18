const { chromium } = require('playwright-core');
const { mkdirSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { Midi } = require('@tonejs/midi');
const { generate, measureLayout } = require('./fresh-dist.cjs').requireFreshService();
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

  const analyze = generate(source, { dMax: 6, smartSelection: true });
  if (!analyze.result.success) throw new Error(analyze.result.error);
  const result = {
    ...analyze.result,
    path: source,
    outputPath: join(directory, 'ui-check.litematic'),
    outputDir: directory,
    appVersion: JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version,
  };
  console.log(
    `fixture: ${result.song.noteCount} notes, ${result.tracks.length} tracks, ` +
      `${result.stats.noteBlockCount + result.stats.circuitBlocks} blocks, ` +
      `${result.outOfRangeNotes} out of range`,
  );

  // A real layout measurement, so the developer readout shows real numbers.
  const layoutMeasure = measureLayout(source, {});

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

    await page.addInitScript(
      (payload) => {
        const { fixture, layoutMeasure } = payload;
        window.__calls = [];
        window.musicbox = {
          onLog() {},
          chooseMidi: async () => fixture.path,
          analyze: async () => fixture,
          generate: async () => fixture,
          plan: async () => ({ info: fixture.smartSelection }),
          measure: async () => layoutMeasure,
          chooseDirectory: async () => ({ path: fixture.outputDir, token: 'ui-verification-token' }),
          saveResourcePack: async () => {
            window.__calls.push('saveResourcePack');
            return 'C:/tmp/musicboxmc-piano-pack.zip';
          },
          appInfo: async () => ({
            name: 'MusicboxMC',
            version: fixture.appVersion,
            license: 'GPL-3.0-only',
            repository: 'https://github.com/xingtuan416/MusicboxMC',
            author: 'xingtuan416',
          }),
          versions: async () => ({
            app: fixture.appVersion,
            electron: '45.3.2',
            chrome: '140.0.0.0',
            node: '26.0.0',
            v8: '14.0',
            appPath: 'stub',
            packaged: false,
          }),
          saveReport: async () => {
            window.__calls.push('saveReport');
            return 'C:/tmp/diagnostics.json';
          },
          reveal: async (p) => {
            window.__calls.push('reveal ' + p);
          },
          open: async () => {},
          pathForFile: () => fixture.path,
          windowControl: async () => {},
        };
      },
      { fixture: result, layoutMeasure },
    );

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

    // Step 1 -> 2, then drop a file on the step. This is the path Electron 32 broke:
    // `File.path` no longer exists, so the preload must resolve the path and the
    // renderer must listen for drop itself.
    await page.locator('#step-1 [data-goto="2"]').click();
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.items.add(
        new File([new Uint8Array([0x4d, 0x54, 0x68, 0x64])], 'dropped.mid', { type: 'audio/midi' }),
      );
      window.__dropData = data;
      const step = document.getElementById('step-2');
      for (const type of ['dragenter', 'dragover']) {
        step.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
      }
    });
    const highlighted = await page.locator('#step-2').evaluate((step) => step.classList.contains('dragover'));
    if (!highlighted) problems.push('step 2 does not highlight while a file is dragged over it');
    await page.evaluate(() => {
      const step = document.getElementById('step-2');
      step.dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__dropData }),
      );
      delete window.__dropData;
    });
    await page.waitForFunction(() => document.getElementById('importLoaded').style.display === 'flex');
    const stillHighlighted = await page
      .locator('#step-2')
      .evaluate((step) => step.classList.contains('dragover'));
    if (stillHighlighted) problems.push('step 2 still highlights after the drop');
    await shot('2-import-loaded');

    // Keep the click fallback covered too. A non-MIDI drop first proves the visible
    // error path, then "重新选择" returns to the empty view and the dialog stub loads
    // the same fixture again.
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array([0])], 'not-midi.txt', { type: 'text/plain' }));
      document
        .getElementById('step-2')
        .dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
    });
    await page.waitForFunction(() => document.getElementById('importError').style.display === 'flex');
    await page.locator('#btnResetImport').click();
    await page.locator('#importEmpty').click();
    await page.waitForFunction(() => document.getElementById('importLoaded').style.display === 'flex');

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
    const firstTrackText = await page.locator('#trackListBox .track-item').first().textContent();
    if (!firstTrackText.includes('识别：')) {
      problems.push('track rows do not show the detected instrument');
    }
    const leadOptions = await page.locator('#leadTrackSelect option').count();
    if (leadOptions !== result.tracks.length) {
      problems.push(`lead selector has ${leadOptions} options, expected ${result.tracks.length}`);
    }
    const leadReason = await page.locator('#leadReason').textContent();
    if (!leadReason || !leadReason.includes('轨 ')) problems.push('lead recommendation has no reason');
    // The card used to be a flex row whose label collapsed to one character per line while
    // the select (width:100% from .input-clean) pushed out past the card. Geometry is the
    // only thing that proves the fix: the text was still there, just unreadable.
    const leadBox = await page.evaluate(() => {
      const panel = document.getElementById('leadPanel').getBoundingClientRect();
      const select = document.getElementById('leadTrackSelect').getBoundingClientRect();
      return {
        inside: select.left >= panel.left - 0.5 && select.right <= panel.right + 0.5,
        reason: document.getElementById('leadReason').getBoundingClientRect().width,
      };
    });
    if (!leadBox.inside) problems.push('the lead selector overflows its card');
    if (leadBox.reason < 200) problems.push(`the lead reason collapsed to ${leadBox.reason}px wide`);
    await page.locator('#leadTrackSelect').selectOption({ index: leadOptions > 1 ? 1 : 0 });
    const manualLead = await page.locator('#leadReason').textContent();
    if (!manualLead.includes('手动指定')) problems.push('lead selector did not record a manual choice');
    await shot('3-tracks');

    await page.locator('#btnStep3Next').click();

    // Entering the step measures the routing by itself. The result is written into the same
    // summaries the manual options write, so the two can never disagree.
    const appliedBadge = () => page.locator('#smartBadge').textContent();
    await page.waitForFunction(() => document.getElementById('smartBadge').textContent === '已应用', null, {
      timeout: 30000,
    });
    const appliedRouting = await page.locator('#smartApplyResult').textContent();
    if (!appliedRouting.includes('最远')) problems.push(`routing line is empty: ${appliedRouting}`);
    const smartPitch = await page.locator('#sumPitch').textContent();
    // This fixture is multi-instrument, so the recommendation has to keep every track on
    // its own instrument: extended mode would push the companion pack onto a song that has
    // no use for it.
    if (!smartPitch.includes('原版乐器')) {
      problems.push(`the applied recommendation is not shown in the summary: ${smartPitch}`);
    }
    const smartPack = await page.locator('#packDescription').textContent();
    if (!smartPack.includes('替换成钢琴')) {
      problems.push(`a multi-instrument song still recommends the pack: ${smartPack}`);
    }
    await shot('4-config-smart');

    await page.locator('[data-fold="fold-pitch"]').click();
    const modeBoxes = await page.locator('[data-cfg-group="instrument"]').count();
    if (modeBoxes !== 2) problems.push(`expected two instrument modes, found ${modeBoxes}`);
    // The other mode, chosen by hand, must update the summary, flip the badge to manual and
    // switch the pack advice to "this mode is the one that needs the pack".
    await page.locator('[data-cfg-group="instrument"][data-cfg-val="extended"]').click();
    const extendedSummary = await page.locator('#sumPitch').textContent();
    if (!extendedSummary.includes('扩展竖琴音域')) {
      problems.push(`extended mode summary is wrong: ${extendedSummary}`);
    }
    const manualBadge = await appliedBadge();
    if (!manualBadge.includes('手动')) problems.push(`manual choice left the badge at ${manualBadge}`);
    const extendedPack = await page.locator('#packDescription').textContent();
    if (!extendedPack.includes('统一扩展竖琴')) {
      problems.push(`extended mode does not recommend the pack: ${extendedPack}`);
    }
    if (await page.locator('#smartSelectionInput').count()) {
      problems.push('the smart checkbox is back; the recommendation is an action now');
    }

    // The button has to restore the recommendation itself, not just the badge.
    await page.locator('#btnSmartApply').click();
    await page.waitForFunction(() => document.getElementById('smartBadge').textContent === '已应用', null, {
      timeout: 30000,
    });
    const restored = await page.locator('#sumPitch').textContent();
    if (!restored.includes('原版乐器')) {
      problems.push(`re-applying the recommendation did not restore native mode: ${restored}`);
    }
    // Developer mode also measures the layout behind the options on this step.
    await page.locator('#btnOpenSettings').click();
    await page.locator('#btnDevMode').click();
    await page.locator('#btnCloseSettings').click();
    await page.locator('#btnDevClose').click();
    await page.waitForFunction(
      () => {
        const element = document.getElementById('devMeasure');
        return element && element.getBoundingClientRect().height > 0 && element.textContent.includes('轨道');
      },
      null,
      { timeout: 30000 },
    );
    const measureText = await page.locator('#devMeasure').textContent();
    if (!/X \d+ × Y \d+ × Z \d+/.test(measureText.replace(/\s+/g, ' '))) {
      problems.push(`dev layout readout has no size: ${measureText}`);
    }
    if (!measureText.includes('MC 轨道'))
      problems.push(`dev layout readout has no track count: ${measureText}`);
    // The readout exists to explain a switch that changed nothing, so the sharing reason
    // has to be part of it.
    if (!measureText.includes('借道'))
      problems.push(`dev layout readout does not explain lane sharing: ${measureText}`);
    // The readout sits at the top of the step; the earlier fold clicks scrolled past it.
    await page.evaluate(() => {
      document.getElementById('step-4').scrollTop = 0;
    });
    await shot('4-config-devmeasure');
    // Back to a clean state for the rest of the flow.
    await page.locator('#btnOpenSettings').click();
    await page.locator('#btnDevMode').click();
    await page.locator('#btnCloseSettings').click();
    // The fold summaries must follow the controls, not stay at their initial text.
    await page.locator('[data-fold="fold-misc"]').click();
    await page.locator('[data-cfg-group="merge"][data-cfg-val="force"]').click();
    const miscSummary = await page.locator('#sumMisc').textContent();
    if (!miscSummary.includes('强制合并')) {
      problems.push(`merge summary did not update: ${miscSummary}`);
    }
    if (!(await appliedBadge()).includes('手动')) {
      problems.push('a manual merge did not switch the badge to 手动');
    }

    // A forced merge leaves one spine, so borrowing and riding have nothing to act on: the
    // cards step aside instead of sitting there inert.
    if (await page.locator('#laneShareCard').isVisible()) {
      problems.push('the sharing card stays visible under a forced merge');
    }
    if (await page.locator('#laneRideCard').isVisible()) {
      problems.push('the riding card stays visible under a forced merge');
    }
    // Back to one line per track, where both switches apply again.
    await page.locator('[data-cfg-group="merge"][data-cfg-val="off"]').click();
    if (!(await page.locator('#laneShareCard').isVisible())) {
      problems.push('the sharing card did not come back when the forced merge was lifted');
    }
    if (!(await page.locator('#laneRideCard').isVisible())) {
      problems.push('the riding card did not come back when the forced merge was lifted');
    }

    // Lane sharing is a switch, not a fourth merge box: it composes with the merge choice.
    const shareSwitch = page.locator('#btnLaneSharing');
    if ((await shareSwitch.getAttribute('role')) !== 'switch') {
      problems.push('lane sharing is not exposed as a switch');
    }
    if ((await shareSwitch.getAttribute('aria-checked')) !== 'true') {
      problems.push('lane sharing is off by default');
    }
    const shareOnSummary = await page.locator('#sumMisc').textContent();
    if (!shareOnSummary.includes('借道 <50 音')) {
      problems.push(`sharing summary is missing while sharing is on: ${shareOnSummary}`);
    }
    await shareSwitch.click();
    if ((await shareSwitch.getAttribute('aria-checked')) !== 'false') {
      problems.push('the sharing switch did not turn off');
    }
    const shareOffSummary = await page.locator('#sumMisc').textContent();
    if (!shareOffSummary.includes('不借道')) {
      problems.push(`sharing summary did not follow the switch: ${shareOffSummary}`);
    }
    if (!(await page.locator('#laneShareSparse').isDisabled())) {
      problems.push('the sparse threshold stays editable while sharing is off');
    }
    await shareSwitch.click();
    if (await page.locator('#laneShareSparse').isDisabled()) {
      problems.push('the sparse threshold stays disabled after sharing is turned back on');
    }
    // The threshold is the definition of "sparse", so it has to reach the summary.
    await page.locator('#laneShareSparse').fill('24');
    await page.locator('#laneShareSparse').press('Tab');
    const shareThresholdSummary = await page.locator('#sumMisc').textContent();
    if (!shareThresholdSummary.includes('借道 <24 音')) {
      problems.push(`the sparse threshold did not reach the summary: ${shareThresholdSummary}`);
    }
    if ((await page.locator('#laneShareSparse').inputValue()) !== '24') {
      problems.push('the sparse threshold input lost the typed value');
    }
    await page.locator('#laneShareSparse').fill('50');
    await page.locator('#laneShareSparse').press('Tab');
    // The switch row spans the fold instead of sitting in one of its three columns, and it
    // must not push anything past the card's edge.
    const shareGeometry = await page.evaluate(() => {
      const card = document.querySelector('#fold-misc .switch-card');
      const content = document.querySelector('#fold-misc .fold-content');
      if (!card || !content) return null;
      const c = card.getBoundingClientRect();
      const p = content.getBoundingClientRect();
      const style = getComputedStyle(content);
      const inner = p.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      return { inside: c.right <= p.right + 1 && c.left >= p.left - 1, width: c.width, content: inner };
    });
    if (!shareGeometry) {
      problems.push('the sharing switch row is missing from the "其它" fold');
    } else if (!shareGeometry.inside) {
      problems.push(`the sharing switch row overflows its fold (${shareGeometry.width}px)`);
    } else if (shareGeometry.width < shareGeometry.content - 4) {
      problems.push(`the sharing switch row does not span the fold (${shareGeometry.width}px)`);
    }
    // Centring is a layout switch of its own: it can be the reason a song is too wide.
    const centerSwitch = page.locator('#btnCenterLead');
    if ((await centerSwitch.getAttribute('role')) !== 'switch') {
      problems.push('lead centring is not exposed as a switch');
    }
    if ((await centerSwitch.getAttribute('aria-checked')) !== 'true') {
      problems.push('lead centring is off by default');
    }
    const centerOnSummary = await page.locator('#sumMisc').textContent();
    if (!centerOnSummary.includes('按主轨排序')) {
      problems.push(`centring summary is missing while centring is on: ${centerOnSummary}`);
    }
    await centerSwitch.click();
    if ((await centerSwitch.getAttribute('aria-checked')) !== 'false') {
      problems.push('the centring switch did not turn off');
    }
    const centerOffSummary = await page.locator('#sumMisc').textContent();
    if (!centerOffSummary.includes('按文件顺序')) {
      problems.push(`centring summary did not follow the switch: ${centerOffSummary}`);
    }
    await centerSwitch.click();
    const centerGeometry = await page.evaluate(() => {
      const cards = document.querySelectorAll('#fold-misc .switch-card');
      const content = document.querySelector('#fold-misc .fold-content');
      const card = cards[0];
      if (!card || !content || cards.length < 2) return null;
      const c = card.getBoundingClientRect();
      const p = content.getBoundingClientRect();
      const style = getComputedStyle(content);
      const inner = p.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      return { inside: c.right <= p.right + 1 && c.left >= p.left - 1, width: c.width, content: inner };
    });
    if (!centerGeometry) {
      problems.push('the centring switch row is missing from the "其它" fold');
    } else if (!centerGeometry.inside || centerGeometry.width < centerGeometry.content - 4) {
      problems.push(
        `the centring switch row does not lay out like the sharing row (${centerGeometry.width}px)`,
      );
    }
    // Borrowed power is its own switch: it rewrites the circuit without touching the merge mode.
    const rideSwitch = page.locator('#btnLaneRide');
    if ((await rideSwitch.getAttribute('role')) !== 'switch') {
      problems.push('lane riding is not exposed as a switch');
    }
    if ((await rideSwitch.getAttribute('aria-checked')) !== 'true') {
      problems.push('lane riding is off by default');
    }
    const rideOnSummary = await page.locator('#sumMisc').textContent();
    if (!rideOnSummary.includes('轨道取电')) {
      problems.push(`riding summary is missing while riding is on: ${rideOnSummary}`);
    }
    await rideSwitch.click();
    if ((await rideSwitch.getAttribute('aria-checked')) !== 'false') {
      problems.push('the riding switch did not turn off');
    }
    const rideOffSummary = await page.locator('#sumMisc').textContent();
    if (!rideOffSummary.includes('不取电')) {
      problems.push(`riding summary did not follow the switch: ${rideOffSummary}`);
    }
    await rideSwitch.click();
    const rideGeometry = await page.evaluate(() => {
      const card = document.querySelector('#btnLaneRide')?.closest('.switch-card');
      const content = document.querySelector('#fold-misc .fold-content');
      if (!card || !content) return null;
      const c = card.getBoundingClientRect();
      const p = content.getBoundingClientRect();
      const style = getComputedStyle(content);
      const inner = p.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      return { inside: c.right <= p.right + 1 && c.left >= p.left - 1, width: c.width, content: inner };
    });
    if (!rideGeometry) {
      problems.push('the riding switch row is missing from the "其它" fold');
    } else if (rideGeometry.inside === false || rideGeometry.width < rideGeometry.content - 4) {
      problems.push(`the riding switch row does not lay out like the sharing row (${rideGeometry.width}px)`);
    }
    // A pasted schematic cannot say which lane is the lead, so the export has to carry a legend.
    const badgeBeforeAnnotate = await page.locator('#smartBadge').textContent();
    const annotateSwitch = page.locator('#btnAnnotateLanes');
    if ((await annotateSwitch.getAttribute('role')) !== 'switch') {
      problems.push('lane annotation is not exposed as a switch');
    }
    if ((await annotateSwitch.getAttribute('aria-checked')) !== 'true') {
      problems.push('lane annotation is off by default');
    }
    const annotateOnSummary = await page.locator('#sumMisc').textContent();
    if (!annotateOnSummary.includes('注释牌')) {
      problems.push(`annotation summary is missing while annotation is on: ${annotateOnSummary}`);
    }
    await annotateSwitch.click();
    if ((await annotateSwitch.getAttribute('aria-checked')) !== 'false') {
      problems.push('the annotation switch did not turn off');
    }
    const annotateOffSummary = await page.locator('#sumMisc').textContent();
    if (!annotateOffSummary.includes('无注释牌')) {
      problems.push(`annotation summary did not follow the switch: ${annotateOffSummary}`);
    }
    // Signs never change the circuit, so switching them must not touch the routing state.
    const badgeAfterAnnotate = await page.locator('#smartBadge').textContent();
    if (badgeAfterAnnotate.trim() !== badgeBeforeAnnotate.trim()) {
      problems.push(
        `toggling annotation changed the routing badge: ${badgeBeforeAnnotate} → ${badgeAfterAnnotate}`,
      );
    }
    await annotateSwitch.click();
    await page.locator('#authorInput').fill('UI check');
    const authorSummary = await page.locator('#sumMisc').textContent();
    if (!authorSummary.includes('UI check')) {
      problems.push(`author summary did not update: ${authorSummary}`);
    }
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

    // What each track became is shown on this step; it has to be populated, not an
    // empty frame.
    const assignmentRows = await page.locator('#assignmentTable .assignment-row').count();
    if (assignmentRows < 2) {
      problems.push(`assignment table has ${assignmentRows} rows, expected a header plus tracks`);
    }
    const assignmentSummary = await page.locator('#sumAssignments').textContent();
    if (!assignmentSummary.includes('条轨')) {
      problems.push(`assignment summary is empty: ${assignmentSummary}`);
    }

    const smartDetail = await page.locator('#smartResultDetail').textContent();
    if (!smartDetail.includes('分类：') || !smartDetail.includes('主音轨：')) {
      problems.push(`smart selection summary is incomplete: ${smartDetail}`);
    }
    if (!smartDetail.includes('投影注释：')) {
      problems.push(`smart selection summary does not mention the lane signs: ${smartDetail}`);
    }

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
    // A pack nudge appears only when smart selection recommends it. When it does, it must
    // be visible and close exactly once.
    const recommended = result.smartSelection?.resourcePackRecommended ?? true;
    const nudges = await page.locator('.modal-backdrop.open').count();
    if (nudges !== (recommended ? 1 : 0)) {
      problems.push(`expected ${recommended ? 1 : 0} resource-pack nudge, found ${nudges}`);
    }
    if (recommended) {
      await page.waitForTimeout(260);
      await page.screenshot({ path: resolve('out/ui-shots/8-pack-nudge.png') });
      await page.getByRole('button', { name: '以后再说' }).click();
      await page.waitForTimeout(200);
      if (await page.locator('.modal-backdrop.open').count()) {
        problems.push('the resource-pack nudge did not close');
      }
    }

    // Developer mode: off by default, toggled from settings, and it must show the live
    // data rather than an empty frame.
    await page.locator('#btnOpenSettings').click();
    const devOff = (await page.locator('#btnDevMode').textContent()).trim();
    if (devOff !== '关闭') problems.push(`developer mode is not off by default: ${devOff}`);
    await page.locator('#btnDevMode').click();
    await page.locator('#btnCloseSettings').click();
    await page.waitForFunction(() => !document.getElementById('devDock').hidden);
    const devState = await page.locator('#devOutput').textContent();
    if (!devState.includes('"versions"') || !devState.includes('"midiPath"')) {
      problems.push(`developer panel shows no data: ${devState.slice(0, 120)}`);
    }
    await page.locator('[data-dev-tab="result"]').click();
    const devResult = await page.locator('#devOutput').textContent();
    if (!devResult.includes('"stats"')) problems.push('developer result tab is empty');
    await page.locator('[data-dev-tab="log"]').click();
    const devLogText = await page.locator('#devOutput').textContent();
    if (!devLogText.includes('ipc')) problems.push('developer log has no IPC entries');
    await shot('9-devmode');
    await page.locator('#btnDevClose').click();
    await page.locator('#btnOpenSettings').click();
    await page.locator('#btnDevMode').click();
    await page.locator('#btnCloseSettings').click();
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

    const doneRows = await page.locator('#doneAssignments .assignment-row').count();
    if (doneRows < 2) {
      problems.push(`result page assignment table has ${doneRows} rows`);
    }
    if (!(await page.locator('#doneAssignments').isVisible())) {
      problems.push('result page assignment table is hidden');
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
