import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseMidi } from '../core/midi/parse';
import type { SongModel } from '../core/midi/types';
import { detectTrack } from '../core/palette/instrumentMap';
import { formatDuration } from '../core/tempo/speed';
import { MAX_LAYOUT_ERROR_MS, MAX_QUANTIZE_ERROR_MS, secondsToTick } from '../core/tempo/tick';
import type { AnalyzeResult, TrackSummary } from './types';

/**
 * Reading a MIDI file and describing it.
 *
 * This is what the GUI shows straight after import, before anything has been
 * generated: song metadata, per-track note counts and the tempo segments.
 */

function summarizeTracks(song: SongModel): TrackSummary[] {
  return song.tracks.map((t) => {
    const ticks = t.notes.map((n) => secondsToTick(n.timeSec));
    const detection = detectTrack(t);
    return {
      index: t.index,
      name: t.name,
      channel: t.channel,
      program: t.program,
      instrument: t.instrument,
      percussion: t.percussion,
      detectedInstrument: detection.native,
      detectionSource: detection.source,
      noteCount: t.notes.length,
      minTick: ticks.length > 0 ? Math.min(...ticks) : 0,
      maxTick: ticks.length > 0 ? Math.max(...ticks) : 0,
    };
  });
}

export function analyze(song: SongModel, path: string): AnalyzeResult {
  return {
    path,
    file: basename(path),
    song: {
      name: song.name,
      ppq: song.ppq,
      durationSec: song.durationSec,
      durationText: formatDuration(song.durationSec),
      baseBpm: song.baseBpm,
      timeSignature: song.timeSignature,
      trackCount: song.tracks.length,
      noteCount: song.tracks.reduce((s, t) => s + t.notes.length, 0),
      commandErrorMs: MAX_QUANTIZE_ERROR_MS,
      layoutErrorMs: MAX_LAYOUT_ERROR_MS,
    },
    tracks: summarizeTracks(song),
    tempoSegments: song.tempos,
  };
}

/** Parse only, without generating circuits. Used to show file info right after import. */
export function analyzeFile(path: string): AnalyzeResult {
  return analyze(parseMidi(readFileSync(path)), path);
}
