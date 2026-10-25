/**
 * The late guard runs on the awaiting caller's clock. Knowledge
 * extraction and interpretation are actions another action awaits with a
 * bounded root; the guard they run before their first model call must spend
 * from that root's deadline, not from a fresh budget of its own.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getFunctionName } from 'convex/server';

const mocks = vi.hoisted(() => ({ generateObject: vi.fn() }));

vi.mock('ai', async () => ({
	...(await vi.importActual<object>('ai')),
	generateObject: (args: unknown) => mocks.generateObject(args),
}));
vi.mock('../../../lib/llmProvider', () => ({
	resolveLanguageModel: vi.fn(async () => ({ modelId: 'guard-model', specificationVersion: 'v2' })),
}));
vi.mock('../../../lib/messageBodyInbound', async (importActual) => ({
	...(await importActual<object>()),
	openInboundMessageBody: vi.fn(async () => ({
		text: 'Please send the invoice.',
		html: undefined,
	})),
}));

import { runGuardBeforeAutonomy } from '../security_scan/guard';
import type { ActionCtx } from '../../../_generated/server';
import type { Doc } from '../../../_generated/dataModel';

const message = {
	_id: 'msg_late',
	subject: 'Invoice',
	securityFlags: {
		injectionDetected: false,
		confidence: 0,
		guardNotRun: { reason: 'agent_disabled', at: 1 },
		scanTimestamp: 1,
	},
} as unknown as Doc<'inboundMessages'>;

function makeCtx() {
	const ledger: Array<{ requests: Array<{ outcome?: string; usage?: unknown }> }> = [];
	const lateGuards: unknown[] = [];
	const ctx = {
		storage: null,
		runMutation: vi.fn(async (ref: unknown, args: unknown) => {
			const name = getFunctionName(ref as never);
			if (name.includes('recordRequests')) ledger.push(args as (typeof ledger)[number]);
			if (name.includes('recordLateGuard')) {
				lateGuards.push(args);
				return 'clear';
			}
			return null;
		}),
		scheduler: { runAfter: vi.fn() },
	} as unknown as ActionCtx;
	return { ctx, ledger, lateGuards };
}

beforeEach(() => {
	mocks.generateObject.mockReset();
});

describe('the late guard on the caller’s deadline', () => {
	it('sends no guard request once the caller’s deadline has passed, and records the guard as incomplete', async () => {
		const { ctx, lateGuards } = makeCtx();
		await runGuardBeforeAutonomy(ctx, message, Date.now() - 1);
		expect(mocks.generateObject).not.toHaveBeenCalled();
		// Fails open for drafting, closed for auto-send: guardUnavailable.
		expect(lateGuards).toEqual([expect.objectContaining({ verdict: { isIncomplete: true } })]);
	});

	it('cuts a guard request off when the caller’s nearly spent deadline runs out, and meters it', async () => {
		// The call's deadline is a native AbortSignal.timeout, which fake timers
		// cannot drive: hand out a signal the test fires instead, and pin the
		// clock so the remaining time is exact.
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-10-01T10:00:00Z'));
		const deadline = new AbortController();
		const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
		let requestSent!: () => void;
		const sent = new Promise<void>((resolve) => (requestSent = resolve));
		mocks.generateObject.mockImplementation(({ abortSignal }: { abortSignal: AbortSignal }) => {
			requestSent();
			return new Promise((_resolve, reject) =>
				abortSignal.addEventListener('abort', () => reject(abortSignal.reason), { once: true })
			);
		});
		const { ctx, ledger, lateGuards } = makeCtx();
		try {
			const guarded = runGuardBeforeAutonomy(ctx, message, Date.now() + 40);
			await sent;
			// Bounded by the caller's 40 ms, not by a fresh 480 s action budget.
			expect(timeout.mock.calls).toEqual([[40]]);
			deadline.abort(new DOMException('The operation timed out.', 'TimeoutError'));
			await guarded;
		} finally {
			timeout.mockRestore();
			vi.useRealTimers();
		}
		expect(mocks.generateObject).toHaveBeenCalledTimes(1);
		expect(ledger.flatMap((call) => call.requests)).toEqual([
			expect.objectContaining({ attempt: 1 }),
		]);
		expect(ledger[0]!.requests[0]!.usage).toBeUndefined();
		expect(lateGuards).toEqual([expect.objectContaining({ verdict: { isIncomplete: true } })]);
	});

	it('runs the guard normally with time left', async () => {
		mocks.generateObject.mockResolvedValue({
			object: { isInjection: false, confidence: 0.02, reason: 'benign' },
			usage: { inputTokens: 30, outputTokens: 6, totalTokens: 36 },
			finishReason: 'stop',
		});
		const { ctx, lateGuards } = makeCtx();
		const out = await runGuardBeforeAutonomy(ctx, message, Date.now() + 60_000);
		expect(out.mayProceed).toBe(true);
		expect(lateGuards).toEqual([expect.objectContaining({ verdict: { isIncomplete: false } })]);
	});
});
