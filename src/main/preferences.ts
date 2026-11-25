import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The handful of choices that have to outlive a window.
 *
 * A plain JSON file in the user's profile, not local storage: the output folder is checked
 * in the main process before anything is written, so the value has to be readable there
 * too, and a file a user can open beats a LevelDB store when someone reports "it forgot my
 * folder". Nothing here affects the schematic itself - a corrupt file only costs a
 * forgotten folder or one extra prompt.
 */
export interface Preferences {
  /** Folder the last schematic was written to; the folder dialog opens here next time. */
  lastOutputDir: string | null;
  /** The user ticked "don't ask again" on the resource-pack reminder. */
  packPromptMuted: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = {
  lastOutputDir: null,
  packPromptMuted: false,
};

/**
 * Fold a patch onto the current values.
 *
 * Unknown keys and wrong types are dropped rather than trusted: the file is editable by
 * hand, and a string where a boolean belongs must not decide whether a dialog appears.
 */
export function mergePreferences(base: Preferences, patch: unknown): Preferences {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return { ...base };
  const record = patch as Record<string, unknown>;
  const next: Preferences = { ...base };
  const folder = record['lastOutputDir'];
  if (typeof folder === 'string' && folder.length > 0) next.lastOutputDir = folder;
  else if (folder === null) next.lastOutputDir = null;
  const muted = record['packPromptMuted'];
  if (typeof muted === 'boolean') next.packPromptMuted = muted;
  return next;
}

/** Read the file, or the defaults when it is missing, unreadable or malformed. */
export function readPreferences(file: string): Preferences {
  try {
    return mergePreferences(DEFAULT_PREFERENCES, JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

/** Return whether the session preferences were also persisted. */
export function writePreferences(file: string, preferences: Preferences): boolean {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(preferences, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}
