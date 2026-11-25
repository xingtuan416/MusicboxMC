import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type {
  AnalyzeResult,
  GenerateOptions,
  GenerateResult,
  GenerationStage,
  LayoutMeasure,
  SmartPlanResult,
} from './types';

interface Results {
  analyze: AnalyzeResult;
  plan: SmartPlanResult;
  measure: LayoutMeasure;
  check: GenerateResult;
  export: { result: GenerateResult; buffer: Uint8Array | null };
}

export interface SongRequest {
  kind: keyof Results;
  path: string;
  options: GenerateOptions;
  sourceRevision?: string;
}

export type SongReply = { stage: GenerationStage } | { value: Results[keyof Results] } | { error: string };

interface Task {
  request: SongRequest;
  resolve: (value: Results[keyof Results]) => void;
  reject: (error: Error) => void;
  dispose: () => void;
  progress?: (stage: GenerationStage) => void;
}

/** One worker owns the most recent prepared layout. Requests run serially to bound memory. */
export class SongTasks {
  private worker: Worker | null = null;
  private pending: Task[] = [];
  private active: Task | null = null;
  private stopping = false;

  run<K extends keyof Results>(
    kind: K,
    path: string,
    options: GenerateOptions = {},
    signal?: AbortSignal,
    progress?: Task['progress'],
    sourceRevision?: string,
  ): Promise<Results[K]> {
    return new Promise((resolve, reject) => {
      signal?.throwIfAborted();
      const abort = (): void => {
        const error = new Error('任务已取消');
        if (this.active === task) this.failWorker(error);
        else {
          this.pending = this.pending.filter((entry) => entry !== task);
          task.dispose();
          reject(error);
        }
      };
      const task: Task = {
        request: { kind, path, options, sourceRevision },
        resolve: (value) => resolve(value as Results[K]),
        reject,
        dispose: () => signal?.removeEventListener('abort', abort),
        progress,
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.push(task);
      this.startNext();
    });
  }

  close(): void {
    const error = new Error('任务已取消');
    for (const task of this.pending) {
      task.dispose();
      task.reject(error);
    }
    this.pending = [];
    this.failWorker(error);
  }

  private startNext(): void {
    if (this.active || this.stopping) return;
    this.active = this.pending.shift() ?? null;
    if (!this.active) return;
    try {
      this.worker ??= this.createWorker();
      this.worker.postMessage(this.active.request);
    } catch (error) {
      this.failWorker(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private createWorker(): Worker {
    const worker = new Worker(join(__dirname, 'songWorker.js'));
    worker.unref();
    worker.on('message', (reply: SongReply) => {
      const task = this.active;
      if (this.worker !== worker || !task) return;
      if ('stage' in reply) {
        task.progress?.(reply.stage);
        return;
      }
      this.active = null;
      task.dispose();
      if ('error' in reply) task.reject(new Error(reply.error));
      else task.resolve(reply.value);
      this.startNext();
    });
    worker.on('error', (error) => {
      if (this.worker === worker)
        this.failWorker(
          new Error('后台生成失败：' + (error instanceof Error ? error.message : String(error))),
        );
    });
    worker.on('exit', (code) => {
      if (this.worker === worker) this.failWorker(new Error('后台生成已停止（' + code + '）'));
    });
    return worker;
  }

  private failWorker(error: Error): void {
    const worker = this.worker;
    this.worker = null;
    const task = this.active;
    this.active = null;
    task?.dispose();
    task?.reject(error);
    if (worker) {
      this.stopping = true;
      void worker
        .terminate()
        .catch(() => {})
        .finally(() => {
          this.stopping = false;
          this.startNext();
        });
    } else {
      this.startNext();
    }
  }
}
