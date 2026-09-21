import { getFunctionName } from 'convex/server';
import { vi } from 'vitest';
import type { ActionCtx } from '../../_generated/server';

export interface RunMutationCall {
	readonly name: string;
	readonly args: Record<string, unknown>;
}

/** The generated function reference, as its stable `module:function` name. */
export const fnName = (ref: unknown): string =>
	getFunctionName(ref as Parameters<typeof getFunctionName>[0]);

/**
 * A dispatcher context that records what it was asked to run. Calls are keyed
 * by the REAL generated function name rather than through a stringifying proxy
 * mock of `_generated/api`: the suites using it also drive the real backend,
 * and the two halves cannot share a file if the generated api is mocked away.
 */
export function makeRecordingActionCtx(): { ctx: ActionCtx; calls: RunMutationCall[] } {
	const calls: RunMutationCall[] = [];
	const ctx = {
		runMutation: vi.fn(async (ref: unknown, args: Record<string, unknown>) => {
			calls.push({ name: fnName(ref), args });
			return { ok: true };
		}),
		scheduler: { runAfter: vi.fn(async () => undefined) },
	} as unknown as ActionCtx;
	return { ctx, calls };
}
