/**
 * Orchestration entry point for the Electron main process.
 *
 * The implementation is split by responsibility — `analyze.ts` reads and
 * summarises a file, `preview.ts` builds the top-down preview, `generate.ts` runs
 * the pipeline — and this module is the single import surface for callers.
 */
export * from './types';
export { analyzeFile } from './analyze';
export { generate, generateToFile } from './generate';
