import { useSyncExternalStore } from 'react';
import { dateTime } from './format';

const subscribe = () => () => {};

/**
 * Formats timestamps for display. The server can't know the viewer's time zone, so server
 * rendering and the hydrating render both use UTC (labelled) and produce identical markup; once
 * hydrated, the component re-renders in the viewer's zone. Client-side navigations start local.
 */
export function useDateTime() {
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  return (ms: number) => dateTime(ms, hydrated ? undefined : 'UTC');
}
