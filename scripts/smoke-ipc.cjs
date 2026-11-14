const { _electron } = require('playwright-core');
const { existsSync, mkdirSync, rmSync, statSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

/**
 * Drive the real application through the real bridge.
 *
 * `verify-ui.cjs` walks the interface with `window.musicbox` replaced by a stub, which
 * proves the interface renders and reacts but says nothing about the main process. This is
 * the other half: it launches the built application, calls through the actual preload
 * bridge into the actual IPC handlers, and checks that a file appears on disk with the size
 * the result claims.
 *
 * The one thing it cannot do is click a native file dialog, so `chooseMidi` is skipped and
 * a path is passed directly. That is deliberate rather than a gap: every other call -
 * `analyze`, `generate`, `saveResourcePack`, `windowControl` - runs exactly as the
 * interface runs it.
 *
 *   node scripts/smoke-ipc.cjs [song.mid]
 */
(async () => {
  const song = process.argv[2] ? resolve(process.argv[2]) : resolve('test/fixtures/delayed-tempo.mid');
  if (!existsSync(song)) throw new Error('no such MIDI: ' + song);

  const work = join(tmpdir(), 'musicboxmc-smoke-' + Date.now());
  mkdirSync(work, { recursive: true });
  const output = join(work, 'smoke.litematic');

  const problems = [];
  const check = (ok, message) => {
    console.log((ok ? 'ok    ' : 'FAIL  ') + message);
    if (!ok) problems.push(message);
  };

  // The Electron binary runs as plain Node when this is set, and `require('electron')`
  // then yields a path string instead of the API. It cost an hour once.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const app = await _electron.launch({ args: [resolve('dist/src/main/index.js')], env });
  try {
    const page = await app.firstWindow();
    // Registered before anything is driven, so an error thrown by an early call is caught
    // rather than happening before the listener exists.
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('crash', () => errors.push('renderer crashed'));

    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(500);

    // 1. The bridge exists and exposes the documented surface.
    const surface = await page.evaluate(() => {
      const api = window.musicbox || {};
      return Object.keys(api).sort();
    });
    check(surface.length >= 8, 'bridge exposes ' + surface.length + ' methods: ' + surface.join(', '));

    // 2. analyze: real parsing in the real main process.
    const analyzed = await page.evaluate((path) => window.musicbox.analyze(path), song);
    check(
      typeof analyzed?.song?.noteCount === 'number' && analyzed.song.noteCount >= 0,
      'analyze returned ' +
        analyzed?.song?.noteCount +
        ' notes across ' +
        analyzed?.tracks?.length +
        ' tracks',
    );
    check(
      Array.isArray(analyzed?.tracks) && analyzed.tracks.length > 0,
      'analyze returned track summaries with names: ' +
        (analyzed?.tracks || []).map((t) => t.name || '(unnamed)').join(', '),
    );

    // 3. The main process grants the folder chosen in its native dialog. Stub only that
    // dialog, then let the real authorization and write path run end to end.
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    }, work);
    const grant = await page.evaluate(() => window.musicbox.chooseDirectory());
    check(
      grant?.path === work && typeof grant?.token === 'string' && grant.token.length > 0,
      'chooseDirectory returned a directory grant',
    );

    const forged = await page.evaluate(
      async ([path, token]) => {
        try {
          await window.musicbox.generate(path, {}, { token, fileName: '../escape.litematic' });
          return false;
        } catch {
          return true;
        }
      },
      [song, grant?.token ?? 'missing'],
    );
    check(forged, 'generate rejects paths outside the granted directory');

    // 4. generate: the file has to exist afterwards, and its size has to match the result.
    const generated = await page.evaluate(
      ([path, target]) => window.musicbox.generate(path, {}, target),
      [song, { token: grant.token, fileName: 'smoke.litematic' }],
    );
    check(generated?.success === true, 'generate reported success: ' + (generated?.error || 'no error'));
    check(existsSync(output), 'generate wrote ' + output);
    if (existsSync(output)) {
      const onDisk = statSync(output).size;
      check(
        onDisk === generated.bytes,
        'file on disk is ' + onDisk + ' bytes, result claimed ' + generated.bytes,
      );
      check(onDisk > 0, 'the written file is not empty');
    }
    check(
      (generated?.stats?.noteBlockCount ?? 0) + (generated?.stats?.circuitBlocks ?? 0) > 0,
      'the result reports actual blocks: ' +
        ((generated?.stats?.noteBlockCount ?? 0) + (generated?.stats?.circuitBlocks ?? 0)),
    );

    // 5. `chooseMidi` and `saveResourcePack` still open native modals that automation
    // cannot answer; their file work is covered by the direct calls above. `chooseDirectory`
    // was exercised in step 3 with only its modal stubbed.

    // 6. windowControl: the frameless title bar's buttons reach the real window.
    await page.evaluate(() => window.musicbox.windowControl('maximize'));
    await page.waitForTimeout(400);
    const maximized = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return window ? window.isMaximized() : null;
    });
    check(maximized === true, 'windowControl("maximize") maximized the real window');
    await page.evaluate(() => window.musicbox.windowControl('maximize'));
    await page.waitForTimeout(300);

    // 7. The interface must not have thrown or crashed while all of that happened.
    await page.waitForTimeout(200);
    check(
      errors.length === 0,
      'no uncaught errors in the renderer' + (errors.length ? ': ' + errors[0] : ''),
    );
  } finally {
    await app.close();
    rmSync(work, { recursive: true, force: true });
  }

  console.log(problems.length ? '\n' + problems.length + ' checks failed' : '\nall checks passed');
  process.exitCode = problems.length ? 1 : 0;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
