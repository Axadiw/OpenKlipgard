/**
 * Worker that executes user camera patterns (WEB-SET-CAMERAS-081). The page
 * terminates it when the wall-clock limit expires, which kills a catastrophic
 * backtracking match without freezing the page.
 */
import { runJob } from './cameraPattern';
import type { JobResult, MatchJob } from './cameraPattern';

export type WorkerReply = { type: 'ready' } | { type: 'results'; results: JobResult[] };

interface WorkerScope {
  onmessage: ((e: MessageEvent<MatchJob[]>) => void) | null;
  postMessage(data: WorkerReply): void;
}
const scope = self as unknown as WorkerScope;

scope.onmessage = (e: MessageEvent<MatchJob[]>) => {
  scope.postMessage({ type: 'results', results: e.data.map(runJob) });
};
// Tells the page the module is loaded, so the match limit does not count the
// worker start (WEB-SET-CAMERAS-081).
scope.postMessage({ type: 'ready' });
