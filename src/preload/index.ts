import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AnalyzeResult, GenerateOptions, GenerateResult } from '../main/service';

/** What the renderer may ask the window to do; it draws its own title bar. */
export type WindowAction = 'minimize' | 'maximize' | 'close';

/**
 * The only entry point visible to the renderer process.
 *
 * Per-feature channels: each method maps to one named IPC channel, and the main process returns
 * structured data per feature. The renderer process never gets the Node API (context isolation +
 * sandbox are enabled throughout); file paths come from main-process dialogs, and the renderer
 * process can only send a path string back.
 */
export interface MusicboxApi {
  /** Open a file dialog and return the chosen MIDI path; returns null on cancel */
  chooseMidi(): Promise<string | null>;
  /** Choose where to save the .litematic; returns null on cancel */
  chooseOutput(defaultName: string): Promise<string | null>;
  /** Write a copy of the bundled resource pack where the user chooses; null on cancel */
  saveResourcePack(): Promise<string | null>;
  /** Parse only, without generating circuits */
  analyze(path: string): Promise<AnalyzeResult>;
  /** Full generation; when the output path is empty, generate without writing to disk */
  generate(path: string, options: GenerateOptions, outputPath?: string): Promise<GenerateResult>;
  /** Reveal the file in the system file manager */
  reveal(path: string): Promise<void>;
  /** Open the file with the system default application */
  open(path: string): Promise<void>;
  /** Logs printed by the main process (e.g. uncaught exceptions), echoed back into the UI */
  onLog(handler: (line: string) => void): void;
  /**
   * Absolute path of a dropped file.
   *
   * Electron removed `File.path` in version 32, so a drag-and-drop target cannot work out
   * where the file lives on its own. `webUtils.getPathForFile` has to be called on the
   * preload side with the original File.
   */
  pathForFile(file: File): string;
  /** The window is frameless, so its buttons come through here. */
  windowControl(action: WindowAction): Promise<void>;
}

const api: MusicboxApi = {
  chooseMidi: () => ipcRenderer.invoke('dialog:choose-midi'),
  chooseOutput: (defaultName) => ipcRenderer.invoke('dialog:choose-output', defaultName),
  saveResourcePack: () => ipcRenderer.invoke('dialog:save-resource-pack'),
  analyze: (path) => ipcRenderer.invoke('song:analyze', path),
  generate: (path, options, outputPath) => ipcRenderer.invoke('song:generate', path, options, outputPath),
  reveal: (path) => ipcRenderer.invoke('shell:reveal', path),
  open: (path) => ipcRenderer.invoke('shell:open', path),
  onLog: (handler) => {
    ipcRenderer.on('app:log', (_e, line: string) => handler(line));
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
  windowControl: (action) => ipcRenderer.invoke('window:control', action),
};

contextBridge.exposeInMainWorld('musicbox', api);
