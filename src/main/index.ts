import { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, shell } from 'electron';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { allowedExternalUrl } from './externalLink';
import {
  analyzeFile,
  generate,
  generateToFile,
  measureLayout,
  planSmartSelection,
  type GenerateOptions,
} from './service';
import { describeCoreError } from './messages';
import { resolveRendererPath } from './rendererPath';
import { grantDirectory, resolveOutputPath } from './outputPaths';
import { handleFatalException } from './fatal';
import { mergePreferences, readPreferences, writePreferences, type Preferences } from './preferences';

/**
 * Where the app keeps its profile (cache, local storage, session data).
 *
 * An unpackaged run (`electron dist/src/main/index.js`) calls itself "Electron", so
 * `userData` defaults to `%APPDATA%\Electron` - the folder every other unpackaged
 * Electron app on the machine uses. Two copies then cannot both own the cache
 * directory: the second one logs "Unable to move the cache: access denied (0x5)" on
 * every start, and both write the same local storage, where a setting changed in one
 * window is invisible in the other. The development build gets a profile of its own;
 * the packaged application keeps `%APPDATA%\MusicboxMC`.
 *
 * `MUSICBOXMC_USER_DATA` overrides both, so a scripted launch (`npm run smoke`,
 * `verify:about`) never fights the window a developer already has open.
 */
const userDataOverride = process.env.MUSICBOXMC_USER_DATA;
if (userDataOverride) {
  app.setPath('userData', userDataOverride);
} else if (!app.isPackaged) {
  app.setPath('userData', join(app.getPath('appData'), 'MusicboxMC-dev'));
}

/**
 * Static asset resolution. The build output layout is dist/src/main/index.js,
 * i.e. __dirname = <root>/dist/src/main, so a single ".." goes back to <root>/dist/src.
 */
const RENDERER_DIR = join(__dirname, '..', 'renderer');

/**
 * The companion resource pack, bundled so the user never has to find it online.
 *
 * It is small (about 50 KB) and the app only copies it out on request; the generator
 * itself does not read it.
 */
const RESOURCE_PACK_FILE = join(__dirname, '..', 'assets', 'musicboxmc-piano-pack-1.20.4.zip');
const PRELOAD_FILE = join(__dirname, '..', 'preload', 'index.js');
const ICON_FILE = existsSync(join(__dirname, 'icon.png'))
  ? join(__dirname, 'icon.png')
  : join(__dirname, '..', '..', '..', 'icon.png');

/**
 * Remembered settings, read once and written back on change.
 *
 * The file sits in `userData`, which the block above may have redirected to a
 * development profile, so the path is resolved on first use rather than at import time.
 */
let cachedPreferences: Preferences | null = null;

function preferences(): Preferences {
  cachedPreferences ??= readPreferences(join(app.getPath('userData'), 'preferences.json'));
  return cachedPreferences;
}

function savePreferences(patch: unknown): Preferences {
  const next = mergePreferences(preferences(), patch);
  cachedPreferences = next;
  writePreferences(join(app.getPath('userData'), 'preferences.json'), next);
  return next;
}

/**
 * The renderer is served over a custom `app://` scheme instead of `file://`.
 *
 * Chromium refuses to load ES module scripts from `file://` because the page has
 * an opaque origin, so a renderer split into modules cannot run that way. Marking
 * the scheme as standard and secure makes module loading work exactly like it does
 * over HTTP, and it keeps the renderer off the file system at the same time.
 *
 * This has to be registered before the app is ready.
 */
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

/** Serve the renderer directory over `app://`, refusing anything outside it. */
function serveRenderer(): void {
  protocol.handle('app', (request) => {
    const target = resolveRendererPath(RENDERER_DIR, new URL(request.url).pathname);
    if (target === null) {
      return new Response('forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(target).toString());
  });
}

let win: BrowserWindow | null = null;

function logToRenderer(line: string): void {
  win?.webContents.send('app:log', line);
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'MusicboxMC',
    icon: ICON_FILE,
    backgroundColor: '#f5f5f2',
    autoHideMenuBar: true,
    // The renderer draws its own title bar, including the window buttons, so the native
    // frame would be a second one above it. The drag region is declared in its CSS.
    frame: false,
    webPreferences: {
      preload: PRELOAD_FILE,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadURL('app://musicbox/index.html');

  win.on('closed', () => {
    win = null;
  });
}

/** Paths from the renderer process must be real files, not arbitrary path strings. */
function assertFile(path: unknown): string {
  if (typeof path !== 'string' || path.length === 0) throw new Error('缺少文件路径');
  if (!existsSync(path)) throw new Error(`文件不存在：${path}`);
  return path;
}

function registerIpc(): void {
  ipcMain.handle('dialog:choose-midi', async () => {
    const res = await dialog.showOpenDialog(win ?? undefined!, {
      title: '选择 MIDI 文件',
      properties: ['openFile'],
      filters: [
        { name: 'MIDI', extensions: ['mid', 'midi'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    });
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]!;
  });

  // Hand the user a copy of the bundled resource pack. Nothing else reads it.
  ipcMain.handle('dialog:save-resource-pack', async () => {
    if (!existsSync(RESOURCE_PACK_FILE)) {
      throw new Error('安装包内的资源包缺失，请重新安装或从 Release 下载');
    }
    const res = await dialog.showSaveDialog(win ?? undefined!, {
      title: '保存配套资源包',
      defaultPath: basename(RESOURCE_PACK_FILE),
      filters: [{ name: 'Minecraft 资源包', extensions: ['zip'] }],
    });
    if (res.canceled || !res.filePath) return null;
    copyFileSync(RESOURCE_PACK_FILE, res.filePath);
    return res.filePath;
  });

  ipcMain.handle('song:analyze', (_e, path: unknown) => {
    try {
      return analyzeFile(assertFile(path));
    } catch (e) {
      throw new Error(`解析失败：${describeCoreError(e)}`, { cause: e });
    }
  });

  ipcMain.handle('song:generate', (_e, path: unknown, options: unknown, outputTarget: unknown) => {
    try {
      const file = assertFile(path);
      const safeOptions = (options ?? {}) as GenerateOptions;
      if (outputTarget !== undefined && outputTarget !== null) {
        const outputPath = resolveOutputPath(outputTarget);
        if (!outputPath) throw new Error('输出位置授权无效或已过期，请重新选择文件夹');
        return generateToFile(file, outputPath, safeOptions);
      }
      return generate(file, safeOptions).result;
    } catch (e) {
      throw new Error(`生成失败：${describeCoreError(e)}`, { cause: e });
    }
  });

  // Layout measurement for the developer panel: no file is written and no litematic bytes
  // are built, so it is cheap enough to run whenever an option changes.
  ipcMain.handle('song:measure', (_e, path: unknown, options: unknown) => {
    try {
      return measureLayout(assertFile(path), (options ?? {}) as GenerateOptions);
    } catch (e) {
      throw new Error(`测量失败：${describeCoreError(e)}`, { cause: e });
    }
  });

  // The configuration step asks what smart routing would choose. Nothing is written; this
  // is a measurement, so the settings the user sees are the ones the generator will use.
  ipcMain.handle('song:plan', (_e, path: unknown, options: unknown) => {
    try {
      return planSmartSelection(assertFile(path), (options ?? {}) as GenerateOptions);
    } catch (e) {
      throw new Error(`智能推荐失败：${describeCoreError(e)}`, { cause: e });
    }
  });

  // Where the schematic goes, without writing it: the file is produced by the next step.
  ipcMain.handle('dialog:choose-directory', async () => {
    if (!win) return null;
    const remembered = preferences().lastOutputDir;
    const picked = await dialog.showOpenDialog(win, {
      title: '选择保存文件夹',
      ...(remembered ? { defaultPath: remembered } : {}),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (picked.canceled || picked.filePaths.length === 0) return null;
    const grant = grantDirectory(picked.filePaths[0]!);
    // Remembered here rather than after generation: the folder was chosen deliberately,
    // and a cancelled generation should still leave the next dialog in the right place.
    savePreferences({ lastOutputDir: grant.path });
    return grant;
  });

  /**
   * The two remembered settings.
   *
   * Kept out of the window's local storage because the main process needs the folder
   * before the renderer exists, and because the resource-pack reminder has to survive a
   * reinstall of the window's storage.
   */
  ipcMain.handle('prefs:get', () => preferences());
  ipcMain.handle('prefs:set', (_e, patch: unknown) => savePreferences(patch));

  /**
   * The application's own version.
   *
   * `app.getVersion()` falls back to Electron's version when the app is not packaged, which
   * is how the About section ended up reporting 33.4.11. The manifest is readable at
   * `app.getAppPath()` in both cases, so the version is taken from there.
   */
  function appVersion(): string {
    // Two candidates: the app path Electron works out, and the project root relative to this
    // compiled file. Running `electron dist/src/main/index.js` does not always give the first
    // one the right answer, because the manifest's `main` points at a different entry.
    const candidates = [
      join(app.getAppPath(), 'package.json'),
      join(__dirname, '..', '..', '..', 'package.json'),
    ];
    for (const candidate of candidates) {
      try {
        const manifest = JSON.parse(readFileSync(candidate, 'utf8'));
        if (typeof manifest.version === 'string' && manifest.version) return manifest.version;
      } catch {
        // Try the next candidate.
      }
    }
    return app.getVersion();
  }

  /**
   * What the About section shows.
   *
   * The version comes from the app itself, so a packaged build cannot disagree with it.
   * The rest is constant: these are the values a GPL project has to state. `package.json`
   * is included in the packaged app, but only `appVersion()` reads it.
   */
  ipcMain.handle('app:info', () => ({
    name: 'MusicboxMC',
    version: appVersion(),
    license: 'GPL-3.0-only',
    repository: 'https://github.com/xingtuan416/MusicboxMC',
    author: 'xingtuan416',
  }));

  /**
   * Runtime versions and paths, for the developer panel.
   *
   * The packaged app bundles its own runtime, so these numbers are the only place the
   * difference between "works here" and "works on the user's machine" can be seen.
   */
  ipcMain.handle('app:versions', () => ({
    app: appVersion(),
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node,
    v8: process.versions.v8 ?? '',
    appPath: app.getAppPath(),
    packaged: app.isPackaged,
  }));

  /**
   * Write a diagnostics report the developer built in the renderer.
   *
   * It is a text file the user chose the location for, capped in size, and nothing in the
   * generator reads it back. The path never becomes an authorized output directory.
   */
  ipcMain.handle('dev:save-report', async (_e, content: unknown, suggested: unknown) => {
    if (typeof content !== 'string' || content.length === 0) throw new Error('诊断内容为空');
    if (content.length > 8_000_000) throw new Error('诊断内容过大（超过 8 MB）');
    const res = await dialog.showSaveDialog(win ?? undefined!, {
      title: '保存诊断报告',
      defaultPath:
        typeof suggested === 'string' && suggested.length > 0
          ? basename(suggested)
          : 'musicboxmc-diagnostics.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePath) return null;
    writeFileSync(res.filePath, content, 'utf8');
    return res.filePath;
  });

  // The window is frameless, so the renderer's own buttons drive these.
  ipcMain.handle('window:control', (_e, action: unknown) => {
    if (!win) return;
    if (action === 'minimize') {
      win.minimize();
    } else if (action === 'maximize') {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    } else if (action === 'close') {
      win.close();
    }
  });

  ipcMain.handle('shell:reveal', (_e, path: unknown) => {
    if (typeof path === 'string' && existsSync(path)) shell.showItemInFolder(path);
  });

  ipcMain.handle('shell:open', async (_e, path: unknown) => {
    if (typeof path !== 'string') return;
    // A URL is not a path: `openPath` would refuse it and the click would do nothing, which
    // is exactly what the repository link in the About section did.
    if (/^https?:\/\//i.test(path)) {
      const target = allowedExternalUrl(path);
      if (target) await shell.openExternal(target);
      return;
    }
    // The renderer only needs to open generated schematics. Do not turn an arbitrary
    // renderer-supplied path into "run this with the system handler".
    if (!path.toLowerCase().endsWith('.litematic') || !existsSync(path)) return;
    const err = await shell.openPath(path);
    if (err) throw new Error(err);
  });
}

/**
 * One window per profile.
 *
 * Starting the app twice used to start two copies against one profile - the cache
 * warnings above, plus two windows whose local storage silently overwrote each
 * other. The second launch now focuses the window that is already open.
 */
const ownsProfile = app.requestSingleInstanceLock();
// `app.quit()` before ready exits with a Windows breakpoint status; `app.exit(0)` is the
// documented way to stop a second instance that never created a window.
if (!ownsProfile) app.exit(0);

app.on('second-instance', () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(() => {
  // Another copy owns this profile and already shows the window: stay out of its way.
  if (!ownsProfile) return;
  // The renderer owns the application chrome; keep Electron's native File/Edit menu hidden.
  Menu.setApplicationMenu(null);
  serveRenderer();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

process.on('uncaughtException', (error) => {
  handleFatalException(error, {
    notify: logToRenderer,
    showError: (title, content) => dialog.showErrorBox(title, content),
    exit: (code) => app.exit(code),
  });
});
