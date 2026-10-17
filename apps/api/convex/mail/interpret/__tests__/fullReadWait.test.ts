/**
 * Read on arrival (Sol r2 F1): an interactive consumer waits a little for a
 * thread's upgrade, then answers `preparing`, and calls no model meanwhile.
 */

import { describe, expect, it, vi } from 'vitest';
import { awaitAskTargetFullRead, awaitFullRead } from '../fullReadPrepare';

const ref = { kind: 'mail' as const, id: 'thread_1' as never };

function ctxOf(prepared: string, fullyReadAfter: number | null) {
	let polls = 0;
	return {
		runMutation: vi.fn(async () => prepared),
		runQuery: vi.fn(async () => {
			polls += 1;
			return fullyReadAfter !== null && polls >= fullyReadAfter;
		}),
	} as never;
}

describe('awaitFullRead', () => {
	it('is ready at once for a fully read thread, without polling', async () => {
		const ctx = ctxOf('ready', null) as { runQuery: ReturnType<typeof vi.fn> };
		expect(await awaitFullRead(ctx as never, ref)).toBe('ready');
		expect(ctx.runQuery).not.toHaveBeenCalled();
	});

	it('waits for the upgrade to land', async () => {
		expect(await awaitFullRead(ctxOf('preparing', 2), ref, { timeoutMs: 500, pollMs: 5 })).toBe(
			'ready'
		);
	});

	it('answers preparing when it does not land in time', async () => {
		expect(await awaitFullRead(ctxOf('preparing', null), ref, { timeoutMs: 30, pollMs: 5 })).toBe(
			'preparing'
		);
		expect(
			await awaitAskTargetFullRead(
				ctxOf('preparing', null),
				{ kind: 'mailDraft', draftId: 'draft_1' as never },
				{ timeoutMs: 30, pollMs: 5 }
			)
		).toBe('preparing');
	});
});
