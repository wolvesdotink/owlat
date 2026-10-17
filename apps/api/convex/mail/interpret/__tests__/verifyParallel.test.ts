/**
 * Verify batches run side by side (verify.ts, at most VERIFY_PARALLELISM in
 * flight) and still produce exactly what the one-after-the-other loop did:
 * the same claim-to-verdict map in the same order, the same incomplete flag
 * and the same refusal, however the calls finish. Every batch is still metered
 * on its own, against its own request id on the run's hold.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionCtx } from '../../../_generated/server';
import { AdmissionRefusedError } from '../../../lib/llm/admissionPort';
import type { VerifyClaim } from '../pipeline';
import type { InterpretRunHold } from '../runHold';
import { VERIFY_PARALLELISM, verifyClaims } from '../verify';

/** How the stubbed verifier answers one batch, by the claim ids it was asked about. */
type Answer = (ids: string[]) => {
	delayMs: number;
	result: { claimId: string; verdict: 'supported' | 'unsupported' | 'unclear' }[] | Error;
};

const stub = vi.hoisted(() => ({
	answer: (() => ({ delayMs: 0, result: [] })) as unknown as Answer,
	inFlight: 0,
	maxInFlight: 0,
	batches: [] as string[][],
	targets: [] as unknown[],
}));

vi.mock('../../../lib/llm/dispatch', () => ({
	runLlmObject: vi.fn(async ({ prompt }: { prompt: string }) => {
		const ids = [...prompt.matchAll(/CLAIM (\S+):/g)].map((m) => m[1]!);
		stub.batches.push(ids);
		stub.inFlight += 1;
		stub.maxInFlight = Math.max(stub.maxInFlight, stub.inFlight);
		const { delayMs, result } = stub.answer(ids);
		await new Promise((resolve) => setTimeout(resolve, delayMs));
		stub.inFlight -= 1;
		if (result instanceof Error) throw result;
		return { object: { verdicts: result }, tokenUsage: undefined, modelUsed: 'stub' };
	}),
}));
vi.mock('../../../analytics/meteredSpend', () => ({
	meterLlmCall: vi.fn(
		async (_ctx: unknown, target: unknown, run: (meter: { requests: unknown[] }) => unknown) => {
			stub.targets.push(target);
			return run({ requests: [{}] });
		}
	),
}));
vi.mock('../../../lib/llmProvider', () => ({ resolveLanguageModel: vi.fn() }));

const ctx = {} as ActionCtx;
const model = { modelId: 'stub' } as never;

function claims(count: number): VerifyClaim[] {
	return Array.from({ length: count }, (_, i) => ({
		id: `item:${i}`,
		statement: `Claim ${i}`,
		quotes: [`quote ${i}`],
	}));
}

const VERDICTS = ['supported', 'unsupported', 'unclear'] as const;

/** Batch `b` (by its first claim) finishes after a delay that reverses the start order. */
function reversed(ids: string[]) {
	const first = Number(ids[0]!.split(':')[1]);
	return {
		delayMs: Math.max(0, 40 - first),
		result: ids.map((claimId, i) => ({ claimId, verdict: VERDICTS[(first + i) % 3]! })),
	};
}

function hold() {
	const counted: number[] = [];
	const value: InterpretRunHold = {
		extractTarget: {},
		verifyTarget: (batch) => ({ reservationId: 'r1', requestId: `verify-${batch}` }),
		claimCheckTarget: () => ({}),
		count: (n) => counted.push(n),
		countClaimChecks: () => {},
		settle: async () => {},
	};
	return { value, counted };
}

/** The serial loop's result and the parallel one's, for the same answers. */
async function both(input: VerifyClaim[], answer: Answer) {
	stub.answer = answer;
	const serial = await verifyClaims(ctx, input, { model, parallelism: 1 });
	stub.maxInFlight = 0;
	stub.batches = [];
	stub.targets = [];
	const parallel = await verifyClaims(ctx, input, { model });
	return { serial, parallel };
}

const entries = (map: Map<string, string>) => [...map.entries()];

beforeEach(() => {
	stub.inFlight = 0;
	stub.maxInFlight = 0;
	stub.batches = [];
	stub.targets = [];
});

describe('verifyClaims in parallel', () => {
	it('returns the serial verdicts, in the serial order, when calls finish out of order', async () => {
		const { serial, parallel } = await both(claims(20), reversed);
		expect(entries(parallel.verdicts)).toEqual(entries(serial.verdicts));
		expect(parallel.verdicts.size).toBe(20);
		expect(parallel).toEqual(serial);
		expect(stub.maxInFlight).toBe(VERIFY_PARALLELISM);
	});

	it('never has more than the bound in flight, and sends every batch once', async () => {
		const { parallel } = await both(claims(26), reversed);
		expect(stub.maxInFlight).toBeLessThanOrEqual(VERIFY_PARALLELISM);
		expect(stub.batches.flat().sort()).toEqual(
			claims(26)
				.map((c) => c.id)
				.sort()
		);
		expect(parallel.isIncomplete).toBe(false);
	});

	it('meters every batch against its own request id and counts each on the hold', async () => {
		const { value, counted } = hold();
		stub.answer = reversed;
		await verifyClaims(ctx, claims(12), { model, hold: value });
		expect(stub.targets.map((t) => (t as { requestId: string }).requestId).sort()).toEqual([
			'verify-0',
			'verify-1',
			'verify-2',
			'verify-3',
		]);
		expect(counted).toEqual([1, 1, 1, 1]);
	});

	it('matches the serial result when a batch fails or answers short', async () => {
		const { serial, parallel } = await both(claims(15), (ids) => {
			const base = reversed(ids);
			if (ids[0] === 'item:3') return { ...base, result: new Error('provider down') };
			if (ids[0] === 'item:9') return { ...base, result: base.result.slice(1) };
			return base;
		});
		expect(parallel).toEqual(serial);
		expect(parallel.isIncomplete).toBe(true);
		expect(parallel.verdicts.has('item:3')).toBe(false);
		expect(parallel.verdicts.has('item:9')).toBe(false);
		expect(parallel.verdicts.has('item:12')).toBe(true);
	});

	it('ignores answers for claims outside the batch and keeps the first answer per claim', async () => {
		const { serial, parallel } = await both(claims(6), (ids) => ({
			delayMs: ids[0] === 'item:0' ? 20 : 0,
			result: [
				{ claimId: ids[0]!, verdict: 'unsupported' },
				{ claimId: ids[0]!, verdict: 'supported' },
				{ claimId: 'item:99', verdict: 'supported' },
				...ids.slice(1).map((claimId) => ({ claimId, verdict: 'supported' as const })),
			],
		}));
		expect(parallel).toEqual(serial);
		expect(parallel.verdicts.get('item:0')).toBe('unsupported');
		expect(parallel.verdicts.has('item:99')).toBe(false);
	});

	it('stops at a spend refusal exactly as the serial loop did, and sends nothing after it', async () => {
		const refusal = new AdmissionRefusedError('daily_ceiling', 'ceiling');
		const answer: Answer = (ids) =>
			ids[0] === 'item:3' ? { delayMs: 0, result: refusal } : { ...reversed(ids), delayMs: 30 };
		const { serial, parallel } = await both(claims(24), answer);
		expect(parallel).toEqual(serial);
		expect(parallel.refusal).toMatchObject({ reason: 'daily_ceiling' });
		expect([...parallel.verdicts.keys()]).toEqual(['item:0', 'item:1', 'item:2']);
		// The first four batches were in flight; none of the other four was sent.
		expect(stub.batches.map((ids) => ids[0])).toEqual(['item:0', 'item:3', 'item:6', 'item:9']);
	});
});
