import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseMidi } from '../core/midi/parse';
import type { SongModel } from '../core/midi/types';
import { detectTrack } from '../core/palette/instrumentMap';
import { formatDuration } from '../core/tempo/speed';
import { BASE_TPS, MAX_LAYOUT_ERROR_MS, MAX_QUANTIZE_ERROR_MS, secondsToTick } from '../core/tempo/tick';
import { numericRange } from '../core/numericRange';
import { chooseLeadTrack, trackProminence, type ProminenceTrack } from '../core/arrangement/prominence';
import type { AnalyzeResult, TrackSummary } from './types';

/**
 * Reading a MIDI file and describing it.
 *
 * This is what the GUI shows straight after import, before anything has been
 * generated: song metadata, per-track note counts and the tempo segments.
 */

function summarizeTracks(song: SongModel, summaryTps: number): TrackSummary[] {
  return song.tracks.map((t) => {
    const ticks = t.notes.map((n) => secondsToTick(n.timeSec, summaryTps));
    const tickRange = numericRange(ticks);
    const midiRange = numericRange(t.notes.map((note) => note.midi));
    const detection = detectTrack(t);
    const prominence = trackProminence(t.notes, song.durationSec);
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
      minTick: tickRange?.min ?? 0,
      maxTick: tickRange?.max ?? 0,
      minMidi: midiRange?.min ?? 0,
      maxMidi: midiRange?.max ?? 0,
      meanVelocity: prominence.meanVelocity,
      maxVelocity: prominence.maxVelocity,
      activeSeconds: prominence.activeSeconds,
      polyphonicOnsetRatio: prominence.polyphonicOnsetRatio,
      melodicScore: prominence.melodicScore,
      activityScore: prominence.activityScore,
      prominenceScore: prominence.prominenceScore,
    };
  });
}

export function analyze(song: SongModel, path: string, summaryTps = BASE_TPS): AnalyzeResult {
  const tracks = summarizeTracks(song, summaryTps);
  const lead = chooseLeadTrack(tracks as ProminenceTrack[]);
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
      summaryTps,
      commandErrorMs: (MAX_QUANTIZE_ERROR_MS * BASE_TPS) / summaryTps,
      layoutErrorMs: (MAX_LAYOUT_ERROR_MS * BASE_TPS) / summaryTps,
    },
    tracks,
    recommendedLeadTrackIndex: lead?.index ?? null,
    recommendedLeadBasis: lead?.basis ?? null,
    tempoSegments: song.tempos,
  };
}

/** Parse only, without generating circuits. Used to show file info right after import. */
export function analyzeFile(path: string): AnalyzeResult {
  return analyze(parseMidi(readFileSync(path)), path);
}
