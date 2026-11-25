const { _electron } = require('playwright-core');
const { Midi } = require('@tonejs/midi');
const {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('node:fs');
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
  // Its own profile: the app holds a single-instance lock per profile, so a smoke run
  // would otherwise exit immediately when a developer already has the window open.
  const profile = join(work, 'profile');
  env.MUSICBOXMC_USER_DATA = profile;

  const app = await _electron.launch({ args: [resolve('dist/src/main/index.js')], env });
  try {
    const usedProfile = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
    check(usedProfile === profile, 'runs on the profile the script asked for: ' + usedProfile);
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

    // Stub the native result while exercising the real Save As bridge and publication path.
    async function chooseOutput(filePath) {
      await app.evaluate(({ dialog }, selected) => {
        dialog.showSaveDialog = async (_window, options) => {
          if (!options.filters?.[0]?.extensions.includes('litematic')) throw new Error('wrong save dialog');
          if (!options.defaultPath?.endsWith('suggested.litematic'))
            throw new Error('missing default filename');
          return { canceled: selected === null, filePath: selected ?? '' };
        };
        dialog.showMessageBox = async () => {
          throw new Error('export displayed a second overwrite dialog');
        };
      }, filePath);
      return page.evaluate(() => window.musicbox.chooseOutput('suggested.litematic'));
    }
    const grant = await chooseOutput(output);
    check(grant?.path === output && !!grant?.token, 'Save As granted the exact filename chosen');

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
    check(forged, 'generate cannot change the path granted by Save As');

    const rejectedDirectory = await page.evaluate(async (path) => {
      try {
        await window.musicbox.analyze(path);
        return false;
      } catch (error) {
        return error.message.includes('当前路径是文件夹');
      }
    }, work);
    check(rejectedDirectory, 'analyze reports directories as invalid MIDI inputs');

    const stages = await page.evaluate(async (path) => {
      const seen = [];
      window.musicbox.onGenerationProgress((id, stage) => seen.push([id, stage]));
      const read = await window.musicbox.generate(path, {}, undefined, 1);
      window.__generationStages = seen;
      return { bytes: read.bytes, success: read.success, seen };
    }, song);
    check(
      stages.success && stages.bytes === 0 && !stages.seen.some(([, stage]) => stage === 'encode'),
      'check prepares a preview without encoding',
    );

    // 4. generate: the file has to exist afterwards, and its size has to match the result.
    const generated = await page.evaluate(
      ([path, target]) => window.musicbox.generate(path, {}, target, 2),
      [song, grant.token],
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

    const exportStages = await page.evaluate(() =>
      window.__generationStages.filter(([id]) => id === 2).map(([, stage]) => stage),
    );
    check(
      exportStages.join(',') === 'encode,write',
      'export reused the checked layout and reported encode/write',
    );

    writeFileSync(output, 'previous export');
    const declined = await chooseOutput(null);
    check(
      declined === null && readFileSync(output, 'utf8') === 'previous export',
      'cancelling Save As leaves an existing file untouched',
    );
    const replacement = await chooseOutput(output);
    const replaced = await page.evaluate(
      ([path, token]) => window.musicbox.generate(path, {}, token),
      [song, replacement.token],
    );
    check(
      replaced?.success === true && statSync(output).size === replaced.bytes,
      'native confirmation authorizes replacement without a second dialog',
    );

    const competingPath = join(work, 'competing.litematic');
    const competing = await chooseOutput(competingPath);
    writeFileSync(competingPath, 'created after the dialog');
    const collision = await page.evaluate(
      ([path, token]) => window.musicbox.generate(path, {}, token),
      [song, competing.token],
    );
    check(
      collision?.chooseOutputAgain === true &&
        readFileSync(competingPath, 'utf8') === 'created after the dialog',
      'a file created after Save As requires a new selection and remains untouched',
    );

    const long = new Midi();
    for (let t = 0; t < 8; t++) {
      const track = long.addTrack();
      for (let i = 0; i < 4000; i++) track.addNote({ midi: 60, ticks: i * 120, duration: 60 });
    }
    const longFile = join(work, 'cancel.mid');
    writeFileSync(longFile, long.toArray());
    const cancelGrant = await chooseOutput(join(work, 'cancel.litematic'));
    const cancelled = await page.evaluate(
      async ([path, token]) => {
        window.musicbox.onGenerationProgress((id, stage) => {
          if (id === 3 && stage === 'layout') void window.musicbox.cancelGeneration(id);
        });
        try {
          await window.musicbox.generate(path, {}, token, 3);
          return false;
        } catch (error) {
          return error.message.includes('任务已取消');
        }
      },
      [longFile, cancelGrant.token],
    );
    check(
      cancelled && !existsSync(join(work, 'cancel.litematic')),
      'cancelling the worker before commit leaves no output',
    );
    const afterCancel = await page.evaluate((path) => window.musicbox.generate(path, {}), song);
    check(afterCancel.success, 'the next check starts a fresh worker after cancellation');

    const mutable = join(work, 'mutable.mid');
    copyFileSync(song, mutable);
    const imported = await page.evaluate((path) => window.musicbox.analyze(path), mutable);
    const beforeChange = await page.evaluate(
      ([path, revision]) => window.musicbox.generate(path, {}, undefined, 4, revision),
      [mutable, imported.sourceRevision],
    );
    check(beforeChange.success && !!imported.sourceRevision, 'check uses the imported MIDI revision');
    writeFileSync(mutable, long.toArray());
    const staleGrant = await chooseOutput(join(work, 'stale.litematic'));
    const stale = await page.evaluate(
      async ([path, token, revision]) => {
        try {
          await window.musicbox.generate(path, {}, token, 5, revision);
          return false;
        } catch (error) {
          return error.message.includes('重新导入');
        }
      },
      [mutable, staleGrant.token, imported.sourceRevision],
    );
    check(stale && !existsSync(join(work, 'stale.litematic')), 'MIDI changed after check cannot be exported');
    const reimported = await page.evaluate((path) => window.musicbox.analyze(path), mutable);
    check(reimported.sourceRevision !== imported.sourceRevision, 'reimport receives the new MIDI revision');

    // 5. Saving the resource pack copies the ZIP bundled by the build.
    const packPath = join(work, 'piano-pack.zip');
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, packPath);
    const savedPack = await page.evaluate(() => window.musicbox.saveResourcePack());
    check(
      savedPack === packPath &&
        existsSync(packPath) &&
        readFileSync(packPath).equals(readFileSync(resolve('assets/musicboxmc-piano-pack-1.20.4.zip'))),
      'saveResourcePack copies the verified bundled resource pack',
    );

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
