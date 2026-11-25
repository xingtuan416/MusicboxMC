import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  AnalyzeResult,
  GenerateOptions,
  GenerateResult,
  GenerationStage,
  LayoutMeasure,
  OutputGrant,
  SmartPlanResult,
} from '../main/service';
import type { Preferences } from '../main/preferences';

/** Facts the About section states about this build. */
export interface AppInfo {
  name: string;
  version: string;
  license: string;
  repository: string;
  author: string;
}

/** Runtime versions and paths, shown by the developer panel. */
export interface AppVersions {
  app: string;
  electron: string;
  chrome: string;
  node: string;
  v8: string;
  appPath: string;
  packaged: boolean;
}

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
  /** Write a copy of the bundled resource pack where the user chooses; null on cancel */
  saveResourcePack(): Promise<string | null>;
  /** Parse only, without generating circuits */
  analyze(path: string): Promise<AnalyzeResult>;
  /** Check without encoding, or export to an authorized target. */
  generate(
    path: string,
    options: GenerateOptions,
    output?: string,
    id?: number,
    revision?: string,
  ): Promise<GenerateResult>;
  cancelGeneration(id: number): Promise<void>;
  onGenerationProgress(handler: (id: number, stage: GenerationStage) => void): void;
  /** Measure what smart routing would choose, without writing a file. */
  plan(path: string, options: GenerateOptions, revision?: string): Promise<SmartPlanResult>;
  /** Measure one layout (X/Y/Z, Minecraft track count) without generating bytes. */
  measure(path: string, options: GenerateOptions, revision?: string): Promise<LayoutMeasure>;
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
  /** Choose the folder a schematic will be written into; the token authorizes that folder. */
  chooseOutput(suggestedName: string): Promise<OutputGrant | null>;
  /** Remembered choices: the last output folder and whether the pack reminder was muted. */
  getPreferences(): Promise<Preferences>;
  /** Change one remembered choice and get the whole record back. */
  setPreferences(patch: Partial<Preferences>): Promise<Preferences & { persisted: boolean }>;
  /** Version, licence and repository, for the About section. */
  appInfo(): Promise<AppInfo>;
  /** Runtime versions and paths, for the developer panel. */
  versions(): Promise<AppVersions>;
  /** Save a diagnostics report the user asked for; null when the dialog was cancelled. */
  saveReport(content: string, suggestedName?: string): Promise<string | null>;
  /** The window is frameless, so its buttons come through here. */
  windowControl(action: WindowAction): Promise<void>;
}

const api: MusicboxApi = {
  chooseMidi: () => ipcRenderer.invoke('dialog:choose-midi'),
  saveResourcePack: () => ipcRenderer.invoke('dialog:save-resource-pack'),
  analyze: (path) => ipcRenderer.invoke('song:analyze', path),
  generate: (path, options, output, id, revision) =>
    ipcRenderer.invoke('song:generate', path, options, output, id, revision),
  cancelGeneration: (id) => ipcRenderer.invoke('song:cancel', id),
  onGenerationProgress: (handler) => {
    ipcRenderer.on('song:progress', (_event, id: number, stage: GenerationStage) => handler(id, stage));
  },
  plan: (path, options, revision) => ipcRenderer.invoke('song:plan', path, options, revision),
  measure: (path, options, revision) => ipcRenderer.invoke('song:measure', path, options, revision),
  reveal: (path) => ipcRenderer.invoke('shell:reveal', path),
  open: (path) => ipcRenderer.invoke('shell:open', path),
  onLog: (handler) => {
    ipcRenderer.on('app:log', (_e, line: string) => handler(line));
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
  windowControl: (action) => ipcRenderer.invoke('window:control', action),
  chooseOutput: (suggestedName) => ipcRenderer.invoke('dialog:choose-output', suggestedName),
  getPreferences: () => ipcRenderer.invoke('prefs:get'),
  setPreferences: (patch) => ipcRenderer.invoke('prefs:set', patch),
  appInfo: () => ipcRenderer.invoke('app:info'),
  versions: () => ipcRenderer.invoke('app:versions'),
  saveReport: (content, suggestedName) => ipcRenderer.invoke('dev:save-report', content, suggestedName),
};

contextBridge.exposeInMainWorld('musicbox', api);
