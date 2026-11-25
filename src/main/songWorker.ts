import { parentPort } from 'node:worker_threads';
import { analyzeFile } from './analyze';
import {
  encodeGeneration,
  measureLayout,
  planSmartSelection,
  prepareGeneration,
  type PreparedGeneration,
} from './generate';
import { describeCoreError } from './messages';
import { sanitizeGenerateOptions } from './options';
import { sourceRevision } from './sourceRevision';
import type { SongReply, SongRequest } from './songTasks';
import type { GenerationStage } from './types';

if (!parentPort) throw new Error('Song worker requires a parent port');
const port = parentPort;

let checked: { key: string; prepared: PreparedGeneration } | undefined;

function run(request: SongRequest): Extract<SongReply, { value: unknown }>['value'] {
  const { kind, path, options } = request;
  const revision = sourceRevision(path, request.sourceRevision);
  if (kind === 'analyze') {
    checked = undefined;
    const result = analyzeFile(path);
    sourceRevision(path, revision);
    return { ...result, sourceRevision: revision };
  }
  if (kind === 'plan') {
    const plan = planSmartSelection(path, options);
    sourceRevision(path, revision);
    return plan;
  }
  if (kind === 'measure') {
    const measure = measureLayout(path, options);
    sourceRevision(path, revision);
    return measure;
  }
  const progress = (stage: GenerationStage): void => port.postMessage({ stage });
  const safeOptions = sanitizeGenerateOptions(options);
  const key = JSON.stringify([path, revision, safeOptions]);
  const previous = checked;
  checked = undefined;
  const prepared =
    previous?.key === key ? previous.prepared : prepareGeneration(path, safeOptions, false, progress);
  prepared.result.sourceRevision = revision;
  if (kind === 'export') {
    const encoded = encodeGeneration(prepared, progress);
    sourceRevision(path, revision);
    return encoded;
  }
  sourceRevision(path, revision);
  if (prepared.result.success) checked = { key, prepared };
  return prepared.result;
}

port.on('message', (request: SongRequest) => {
  try {
    port.postMessage({ value: run(request) } satisfies SongReply);
  } catch (error) {
    port.postMessage({ error: describeCoreError(error) } satisfies SongReply);
  }
});
