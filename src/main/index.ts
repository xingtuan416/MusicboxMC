import { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, shell } from 'electron';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { copyFileSync, existsSync } from 'node:fs';
import { analyzeFile, generate, generateToFile, type GenerateOptions } from './service';
import { describeCoreError } from './messages';
import { resolveRendererPath } from './rendererPath';

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

  ipcMain.handle('dialog:choose-output', async (_e, defaultName: unknown) => {
    const raw = typeof defaultName === 'string' && defaultName.length > 0 ? defaultName : 'output';
    const name = raw.replace(/\.litematic$/i, '');
    const res = await dialog.showSaveDialog(win ?? undefined!, {
      title: '保存投影',
      defaultPath: `${name}.litematic`,
      filters: [{ name: 'Litematica 投影', extensions: ['litematic'] }],
    });
    return res.canceled || !res.filePath ? null : res.filePath;
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

  ipcMain.handle('song:generate', (_e, path: unknown, options: GenerateOptions, outputPath: unknown) => {
    try {
      const file = assertFile(path);
      if (typeof outputPath === 'string' && outputPath.length > 0) {
        return generateToFile(file, outputPath, options ?? {});
      }
      return generate(file, options ?? {}).result;
    } catch (e) {
      throw new Error(`生成失败：${describeCoreError(e)}`, { cause: e });
    }
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
    if (typeof path !== 'string' || !existsSync(path)) return;
    const err = await shell.openPath(path);
    if (err) throw new Error(err);
  });
}

app.whenReady().then(() => {
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

process.on('uncaughtException', (e) => {
  logToRenderer(`[主进程异常] ${e.message}`);
});
