import { useEffect } from 'react';
import { useRecordings } from '../hooks/useRecordings';
import { TimelineView } from './TimelineView';
import { useShell } from './AuthedShell';

/** The timeline page. It has no toolbar of its own: switching to the grid is
 *  the header nav (WEB-SHELL-016, WEB-TIMELINE-002). */
export function TimelineRoute() {
  const recordings = useRecordings();
  const shell = useShell();

  useEffect(() => {
    recordings.loadCameras();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <TimelineView
      cameraFilter={recordings.filters.cameras}
      onPlay={shell.openPlayer}
      allCameras={recordings.cameras}
    />
  );
}
