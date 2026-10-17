/**
 * The per-message verify claim cap (ADR-0073, plan Phase 3), end to end through
 * `interpretMessage` with a stubbed model:
 *
 * - No cap (the default): every claim is checked, in one call, as today.
 * - A cap: only the first claims are checked; a claim over the cap gets no
 *   verdict, so it is never applied (an item stays a proposal), and the run is
 *   `partial` (`verify_capped`), which holds auto-send for a person and is not
 *   retried. A claim over the cap is never silently accepted.
 */

import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { internal } from '../../../_generated/api';
import { enableFeatures } from '../../../__tests__/factories';
import { briefModelSchema } from '../schema';
import { modules, seedMailThread, type Test } from './interpret.testlib';
import { captureInterpretSource } from '../sources';
import { interpretationHoldReason } from '../teamActions';
import { runStatusOf } from '../pipeline';
import { nextRetryAtOf } from '../retry';

const llm = vi.hoisted(() => ({ runLlmObject: vi.fn() }));

vi.mock('../../../lib/llm/dispatch', async () => {
	const { metered } = await import('../../../analytics/__tests__/meteredDispatch.testlib');
	return { runLlmObject: metered((opts: unknown) => llm.runLlmObject(opts)) };
});
vi.mock('../../../lib/llmProvider', () => ({
	resolveLanguageModel: vi.fn(async () => ({ modelId: 'stub-model' })),
}));

const TEXT = 'Could you send me the signed contract by Friday and pay the invoice by Monday?';

function item(assertion: string, quote: string) {
	return {
		matchItemId: null,
		intent: 'request',
		facets: ['file'],
		consequences: ['payment'],
		assertion,
		display: { en: assertion, de: assertion },
		requester: { ref: 'p1', name: null, email: null },
		responsible: { ref: null, name: null, email: 'me@owlat.test' },
		beneficiary: null,
		due: null,
		amount: null,
		options: null,
		quotes: [{ segmentId: 's0', text: quote }],
	};
}

const OUTPUT = {
	mode: 'brief',
	items: [
		item('Send the signed contract', 'send me the signed contract by Friday'),
		item('Pay the invoice', 'pay the invoice by Monday'),
	],
	transitions: [],
	replyIntent: 'request_for_action',
	urgency: 'normal',
	meetingIntent: null,
	coverage: { segmentsRead: ['s0'], uncertain: false, overflow: false },
	latest: { en: [], de: [] },
	facts: [],
};

/** The claim ids each verifier call was asked about. */
const verifierClaims = () =>
	llm.runLlmObject.mock.calls
		.map(([opts]) => opts as { schema: unknown; prompt: string })
		.filter((opts) => opts.schema !== briefModelSchema)
		.map((opts) => [...opts.prompt.matchAll(/CLAIM (\S+):/g)].map((m) => m[1]));

beforeEach(() => {
	llm.runLlmObject.mockReset();
	llm.runLlmObject.mockImplementation(
		async ({ schema, prompt }: { schema: unknown; prompt: string }) => {
			if (schema === briefModelSchema) {
				return { object: OUTPUT, tokenUsage: undefined, modelUsed: 'stub-model' };
			}
			const ids = [...prompt.matchAll(/CLAIM (\S+):/g)].map((m) => m[1]);
			return {
				object: { verdicts: ids.map((claimId) => ({ claimId, verdict: 'supported' })) },
				tokenUsage: undefined,
				modelUsed: 'stub-model',
			};
		}
	);
});

async function interpret(t: Test, cap: number | null) {
	await enableFeatures(t, ['ai']);
	if (cap !== null) {
		await t.run(async (ctx) => {
			await ctx.db.insert('aiRoutingPolicy', {
				verifyClaimCapPerMessage: cap,
				policyVersion: 1,
				updatedAt: Date.now(),
				updatedBy: 'admin-1',
			});
		});
	}
	rateLimiterTest.register(t);
	const seeded = await seedMailThread(t, { text: TEXT });
	await t.run((ctx) =>
		captureInterpretSource(ctx, { source: { kind: 'mail', id: seeded.messageId }, isLive: true })
	);
	const out = await t.action(internal.mail.interpret.run.interpretMessage, {
		source: { kind: 'mail', id: seeded.messageId },
	});
	const items = await t.run((ctx) => ctx.db.query('threadItems').collect());
	const row = await t.run((ctx) => ctx.db.query('messageInterpretations').first());
	return { out, items, row };
}

describe('the per-message verify claim cap', () => {
	it('checks every claim when no cap is set (today)', async () => {
		const { out, items } = await interpret(convexTest(schema, modules), null);
		expect(out).toMatchObject({ status: 'complete' });
		expect(verifierClaims()).toEqual([['item:0', 'item:1']]);
		expect(items.map((i) => i.verify).sort()).toEqual(['passed', 'passed']);
	});

	it('leaves a claim over the cap unverified, the run partial, and nothing retried', async () => {
		const { out, items, row } = await interpret(convexTest(schema, modules), 1);
		expect(verifierClaims()).toEqual([['item:0']]);
		expect(out).toMatchObject({ status: 'partial', errorCode: 'verify_capped' });
		const byAssertion = Object.fromEntries(items.map((i) => [i.assertion, i.verify]));
		expect(byAssertion).toEqual({
			'Send the signed contract': 'passed',
			'Pay the invoice': 'proposal',
		});
		expect(row).toMatchObject({ status: 'partial', errorCode: 'verify_capped' });
		expect(row?.nextRetryAt).toBeUndefined();
		// A partial interpretation holds auto-send for a person.
		expect(
			interpretationHoldReason({
				interpretation: { status: 'partial' } as never,
				completeness: 'complete',
			})
		).toMatch(/partial/);
	});

	it('changes nothing when the cap is not reached', async () => {
		const { out } = await interpret(convexTest(schema, modules), 2);
		expect(out).toMatchObject({ status: 'complete' });
		expect(verifierClaims()).toEqual([['item:0', 'item:1']]);
	});
});

describe('the status of an unverified claim', () => {
	const clean = {
		grounding: { coverage: { complete: true, gaps: [] } },
		output: { coverage: { segmentsRead: [], uncertain: false, overflow: false } },
		isItemsOverflow: false,
		isFactsOverflow: false,
		truncatedSegmentIds: [],
		isVerifyIncomplete: false,
	} as unknown as Parameters<typeof runStatusOf>[0];

	it.each([
		[{ isVerifyCapped: true }, 'verify_capped'],
		[{ isVerifyUnavailable: true }, 'verify_unavailable'],
		[{ isVerifyUnsendable: true }, 'verify_unsendable'],
		[{ isVerifyCapped: true, isVerifyIncomplete: true }, 'verify'],
	])('%o is partial with %s', (flags, errorCode) => {
		expect(runStatusOf({ ...clean, ...flags })).toEqual({ status: 'partial', errorCode });
	});

	it('retries a transient failure, never a capped, unavailable or unsendable claim', () => {
		const now = 1_000;
		expect(nextRetryAtOf({ status: 'partial', errorCode: 'verify' }, now)).toBeGreaterThan(now);
		for (const errorCode of ['verify_capped', 'verify_unavailable', 'verify_unsendable']) {
			expect(nextRetryAtOf({ status: 'partial', errorCode }, now)).toBeUndefined();
		}
	});
});
