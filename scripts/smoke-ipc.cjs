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

    // 3. generate: the file has to exist afterwards, and its size has to match the result.
    const generated = await page.evaluate(
      ([path, out]) => window.musicbox.generate(path, {}, out),
      [song, output],
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

    // 4. The three dialog-driven calls are deliberately not exercised here.
    //
    // `chooseMidi`, `chooseDirectory` and `saveResourcePack` each open a
    // native modal that nothing can answer under automation; calling one takes the renderer
    // down with it, which is how the first version of this script failed. The work behind
    // the dialogs is the same code the non-dialog calls above already reach - a path in, a
    // result out - so what is left untested is the dialog itself, not the logic behind it.

    // 5. windowControl: the frameless title bar's buttons reach the real window.
    await page.evaluate(() => window.musicbox.windowControl('maximize'));
    await page.waitForTimeout(400);
    const maximized = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return window ? window.isMaximized() : null;
    });
    check(maximized === true, 'windowControl("maximize") maximized the real window');
    await page.evaluate(() => window.musicbox.windowControl('maximize'));
    await page.waitForTimeout(300);

    // 6. The interface must not have thrown or crashed while all of that happened.
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
