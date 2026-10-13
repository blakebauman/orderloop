import { atLeast, type Principal, type Role } from '@orderloop/core';
import { useRouteLoaderData } from 'react-router';

/** The signed-in principal, from the app shell's loader. */
export function useMe(): Principal | null {
  return (useRouteLoaderData('routes/shell') as { me?: Principal } | undefined)?.me ?? null;
}

/**
 * Whether the signed-in role may use a control. The server checks every action regardless; this
 * only keeps controls a role can't use out of the way.
 */
export function useCan(min: Role): boolean {
  return atLeast(useMe()?.role, min);
}
