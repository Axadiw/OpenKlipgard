import { Suspense, type ReactElement } from 'react';
import { KlipgardLoader } from './components/KlipgardLoader';

// Suspense fallback: the Klipgard loader, centred (WEB-002, WEB-SHELL-079).
export function RouteFallback() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '50vh' }}>
      <KlipgardLoader />
    </div>
  );
}

/** Wrap a lazy element in a Suspense boundary with the shared fallback. */
export function lazyEl(node: ReactElement): ReactElement {
  return <Suspense fallback={<RouteFallback />}>{node}</Suspense>;
}
