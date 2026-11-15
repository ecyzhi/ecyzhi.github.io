/// <reference lib="webworker" />
import { trace, type TraceOptions } from './trace';

export interface TraceRequest {
  id: number;
  width: number;
  height: number;
  data: Uint8ClampedArray;
  options: TraceOptions;
}

export type TraceResponse =
  | { id: number; type: 'progress'; stage: string }
  | { id: number; type: 'done'; svg: string; shapes: number; palette: string[]; threshold?: number; ms: number }
  | { id: number; type: 'error'; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<TraceRequest>) => {
  const { id, width, height, data, options } = e.data;
  const t0 = performance.now();
  try {
    const res = trace({ data, width, height }, options, (stage) => ctx.postMessage({ id, type: 'progress', stage } satisfies TraceResponse));
    ctx.postMessage({ id, type: 'done', ...res, ms: Math.round(performance.now() - t0) } satisfies TraceResponse);
  } catch (err) {
    ctx.postMessage({ id, type: 'error', message: err instanceof Error ? err.message : String(err) } satisfies TraceResponse);
  }
};
