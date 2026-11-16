import { useEffect, useRef, useState } from 'react';
import type { JobResult, MatchJob } from '../../lib/cameraPattern';
import { PREVIEW_DEBOUNCE_MS } from '../../lib/cameraPattern';
import { runBatch } from '../../lib/cameraPatternRunner';

export interface PreviewPattern { key: string; source: string }

export type PreviewState = 'idle' | 'pending' | 'ready' | 'slow' | 'unavailable';

export const resultKey = (key: string, name: string) => `${key}\u0000${name}`;

/**
 * Debounced, worker-guarded evaluation of `patterns` against `names`
 * (WEB-SET-CAMERAS-050, -081). `selected` comes first: if the whole batch
 * hits the time limit, the web app retries with the selected pattern alone
 * to learn whether that one is the slow pattern.
 *
 * The first run for a given selected profile starts at once. Later runs for
 * the same profile wait for the debounce, so typing does not spawn a worker
 * per keystroke.
 */
export function usePatternPreview(
  selected: PreviewPattern | null,
  others: PreviewPattern[],
  names: string[],
): { state: PreviewState; results: Record<string, JobResult> } {
  const [state, setState] = useState<PreviewState>('idle');
  const [results, setResults] = useState<Record<string, JobResult>>({});
  const lastKey = useRef<string | null>(null);

  const patterns = [...(selected ? [selected] : []), ...others];
  const signature = JSON.stringify([patterns.map(p => [p.key, p.source]), names]);

  useEffect(() => {
    const wait = selected && lastKey.current === selected.key ? PREVIEW_DEBOUNCE_MS : 0;
    lastKey.current = selected?.key ?? null;
    let live = true;
    setState('pending');
    const timer = setTimeout(async () => {
      const jobs: MatchJob[] = patterns
        .filter(p => p.source.trim().length > 0)
        .flatMap(p => names.map(name => ({ key: resultKey(p.key, name), source: p.source, name })));
      if (jobs.length === 0) {
        if (live) { setResults({}); setState('ready'); }
        return;
      }
      let outcome = await runBatch(jobs);
      if (!live) return;
      if (outcome.kind === 'timeout' && selected) {
        const own = jobs.filter(j => j.key.startsWith(`${selected.key}\u0000`));
        const retry = await runBatch(own);
        if (!live) return;
        if (retry.kind === 'timeout') { setResults({}); setState('slow'); return; }
        outcome = retry;
      }
      if (outcome.kind === 'timeout') { setResults({}); setState('slow'); return; }
      if (outcome.kind === 'unavailable') { setResults({}); setState('unavailable'); return; }
      const map: Record<string, JobResult> = {};
      for (const r of outcome.results) map[r.key] = r;
      setResults(map);
      setState('ready');
    }, wait);
    return () => { live = false; clearTimeout(timer); };
    // `signature` captures patterns and names.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return { state, results };
}
