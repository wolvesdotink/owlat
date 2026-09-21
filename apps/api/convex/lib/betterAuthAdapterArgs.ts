import type { MutationCtx } from '../_generated/server';

type BetterAuthAdapterArgs = Parameters<MutationCtx['runMutation']>[1];

/**
 * The BetterAuth component adapter (`components.betterAuth.adapter.*`) is typed
 * loosely by the component's generated API, so every direct call has to cast
 * its `input`. This is the single place that cast lives; callers pass the
 * adapter payload as written in `@convex-dev/better-auth`.
 */
export function betterAuthAdapterArgs(args: Record<string, unknown>): BetterAuthAdapterArgs {
	return args as unknown as BetterAuthAdapterArgs;
}
