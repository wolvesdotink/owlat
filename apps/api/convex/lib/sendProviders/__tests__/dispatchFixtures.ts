import { vi } from 'vitest';
import type { sendProviderDispatch } from '../dispatch';

export interface ScheduledCall {
	readonly args: Record<string, unknown>;
}

/**
 * The action context `sendProviderDispatch` needs and nothing more: a
 * `runMutation` that reports success and a scheduler whose `runAfter` calls
 * land in `scheduled`, so a suite can read back what the dispatch queued.
 */
export function fakeDispatchCtx(
	scheduled: ScheduledCall[] = []
): Parameters<typeof sendProviderDispatch>[0] {
	return {
		runMutation: vi.fn(async () => true),
		scheduler: {
			runAfter: vi.fn(async (_delay: number, _ref: unknown, args: Record<string, unknown>) => {
				scheduled.push({ args });
			}),
		},
	} as unknown as Parameters<typeof sendProviderDispatch>[0];
}
