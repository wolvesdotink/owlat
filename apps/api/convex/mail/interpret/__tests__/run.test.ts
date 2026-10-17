/**
 * `interpretMessage` end to end with a stubbed model (mail/interpret/run.ts):
 * load → scope → segment → gate → model → ground → verify → reduce, the
 * fail-soft paths, eligibility skips, and dedupe of an applied revision.
 */

import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { internal } from '../../../_generated/api';
import { enableFeatures } from '../../../__tests__/factories';
import { actionsModelSchema, briefModelSchema } from '../schema';
import { modules, seedMailThread, type Test } from './interpret.testlib';
import { captureInterpretSource } from '../sources';
import { AdmissionRefusedError } from '../../../lib/llm/admissionPort';
import { reconcileSpend } from '../../../aiRouting/__tests__/spend.testlib';

/** Seed a message and take its enqueue-time snapshot, as delivery does. */
async function seedCaptured(
	t: Test,
	seed: Parameters<typeof seedMailThread>[1] & { isLive?: boolean } = {}
) {
	const seeded = await seedMailThread(t, seed);
	await t.run(async (ctx) =>
		captureInterpretSource(ctx, {
			source: { kind: 'mail', id: seeded.messageId },
			isLive: seed.isLive ?? true,
		})
	);
	return seeded;
}

const llm = vi.hoisted(() => ({ runLlmObject: vi.fn() }));

vi.mock('../../../lib/llm/dispatch', async () => {
	const { metered } = await import('../../../analytics/__tests__/meteredDispatch.testlib');
	return { runLlmObject: metered((opts: unknown) => llm.runLlmObject(opts)) };
});
vi.mock('../../../lib/llmProvider', () => ({
	resolveLanguageModel: vi.fn(async () => ({ modelId: 'stub-model' })),
}));

const TEXT = 'Could you send me the signed contract by Friday?';

function modelOutput(segmentId: string) {
	return {
		mode: 'brief',
		items: [
			{
				matchItemId: null,
				intent: 'request',
				facets: ['file', 'signature'],
				consequences: ['signature'],
				assertion: 'Send the signed contract',
				display: {
					en: 'Send Jonas the signed contract',
					de: 'Schick Jonas den unterschriebenen Vertrag',
				},
				requester: { ref: 'p1', name: null, email: null },
				responsible: { ref: null, name: null, email: 'me@owlat.test' },
				beneficiary: null,
				due: { phrase: 'by Friday', at: '2026-10-09', tz: null, ambiguous: false, condition: null },
				amount: null,
				options: null,
				quotes: [{ segmentId, text: 'send me the signed contract by Friday' }],
			},
		],
		transitions: [],
		replyIntent: 'request_for_action',
		urgency: 'normal',
		meetingIntent: null,
		coverage: { segmentsRead: [segmentId], uncertain: false, overflow: false },
		latest: {
			en: [
				{
					text: 'Jonas wants the signed contract.',
					quotes: [{ segmentId, text: 'signed contract' }],
				},
			],
			de: [{ text: 'Jonas will den Vertrag.', quotes: [{ segmentId, text: 'signed contract' }] }],
		},
		facts: [],
	};
}

beforeEach(() => {
	llm.runLlmObject.mockReset();
	llm.runLlmObject.mockImplementation(async ({ schema }: { schema: unknown }) => {
		if (schema === briefModelSchema) {
			return {
				object: modelOutput('s0'),
				tokenUsage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 },
				modelUsed: 'stub-model',
			};
		}
		// The verifier: support every claim it is asked about.
		return {
			object: { verdicts: [{ claimId: 'item:0', verdict: 'supported' }] },
			tokenUsage: { promptTokens: 2, completionTokens: 0, totalTokens: 2 },
			modelUsed: 'stub-model',
		};
	});
});

describe('interpretMessage', () => {
	it('interprets, verifies and folds the message into its thread', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai']);
		const { messageId, threadId } = await seedCaptured(t, { text: TEXT });
		const out = await t.action(internal.mail.interpret.run.interpretMessage, {
			source: { kind: 'mail', id: messageId },
		});
		expect(out).toMatchObject({
			status: 'complete',
			createdItemIds: [expect.any(String)],
			projection: {
				replyIntent: 'request_for_action',
				askSummary: 'Send Jonas the signed contract',
				dueHint: '2026-10-09',
				isOnlyTheirs: false,
			},
		});
		const items = await t.run(async (ctx) => ctx.db.query('threadItems').collect());
		expect(items[0]).toMatchObject({
			mailThreadId: threadId,
			verify: 'passed',
			responsibility: 'us',
		});
		const rows = await t.run((ctx) => ctx.db.query('llmUsageEvents').collect());
		expect(rows.map((row) => [row.feature, row.rootRequestId])).toEqual([
			['interpret', `postbox:${messageId}`],
			['interpret_verify', `postbox:${messageId}`],
		]);
		// The verifier read the claim and its quote, nothing else.
		const verifyPrompt = llm.runLlmObject.mock.calls[1]?.[0]?.prompt as string;
		expect(verifyPrompt).toContain('CLAIM item:0');
		expect(verifyPrompt).toContain('send me the signed contract by Friday');
	});

	describe('a claim too long to send the verifier (Sol r5 F1)', () => {
		const long =
			'Could you send me the signed contract by Friday, ' +
			'together with every appendix, every schedule and the cover letter we went through on the call last week, '.repeat(
				4
			) +
			'but do not send anything until I confirm.';
		const seedLong = async (t: Test) => {
			await enableFeatures(t, ['ai']);
			const { messageId } = await seedCaptured(t, { text: long });
			const output = modelOutput('s0');
			output.items[0]!.quotes = [{ segmentId: 's0', text: long }];
			return { source: { kind: 'mail' as const, id: messageId }, output };
		};

		it('is never verified, and the run is partial with no retry and no further extraction', async () => {
			expect(long.length).toBeGreaterThan(400);
			const t = convexTest(schema, modules);
			rateLimiterTest.register(t);
			const { source, output } = await seedLong(t);
			llm.runLlmObject.mockImplementation(async ({ schema }: { schema: unknown }) => {
				if (schema === briefModelSchema) return { object: output };
				return { object: { verdicts: [{ claimId: 'item:0', verdict: 'supported' }] } };
			});

			const out = await t.action(internal.mail.interpret.run.interpretMessage, { source });

			// The extraction only: the clipped claim never reached the verifier.
			expect(llm.runLlmObject).toHaveBeenCalledTimes(1);
			expect(out).toMatchObject({ status: 'partial', errorCode: 'verify_unsendable' });
			if (!('isReplayed' in out)) throw new Error('unreachable');
			expect(out.retryAt).toBeUndefined();
			const items = await t.run(async (ctx) => ctx.db.query('threadItems').collect());
			expect(items).toHaveLength(1);
			expect(items[0]?.verify).not.toBe('passed');
			const row = (await t.run((ctx) => ctx.db.query('messageInterpretations').collect())).find(
				(r) => r.isCounted
			);
			expect(row).toMatchObject({ status: 'partial', errorCode: 'verify_unsendable' });
			expect(row?.nextRetryAt).toBeUndefined();

			// Asked again: answered from the stored extraction, nothing bought.
			llm.runLlmObject.mockClear();
			const again = await t.action(internal.mail.interpret.run.interpretMessage, { source });
			expect(again).toMatchObject({
				status: 'partial',
				isReplayed: true,
				errorCode: 'verify_unsendable',
			});
			expect(llm.runLlmObject).not.toHaveBeenCalled();
		});

		it('lets a transient verifier failure in the same run win, so the run retries', async () => {
			const t = convexTest(schema, modules);
			rateLimiterTest.register(t);
			const { source, output } = await seedLong(t);
			// A second, sendable claim whose verify call fails.
			const short = modelOutput('s0').items[0]!;
			short.quotes = [{ segmentId: 's0', text: 'send me the signed contract by Friday' }];
			output.items.push(short);
			llm.runLlmObject.mockImplementation(async ({ schema }: { schema: unknown }) => {
				if (schema === briefModelSchema) return { object: output };
				throw new Error('verifier down');
			});

			const out = await t.action(internal.mail.interpret.run.interpretMessage, { source });

			expect(out).toMatchObject({ status: 'partial', errorCode: 'verify' });
			if (!('isReplayed' in out)) throw new Error('unreachable');
			expect(out.retryAt).toBeGreaterThan(Date.now());
		});
	});

	it('reuses an applied revision instead of calling the model again', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai']);
		const { messageId } = await seedCaptured(t, { text: TEXT });
		await t.action(internal.mail.interpret.run.interpretMessage, {
			source: { kind: 'mail', id: messageId },
		});
		llm.runLlmObject.mockClear();
		const again = await t.action(internal.mail.interpret.run.interpretMessage, {
			source: { kind: 'mail', id: messageId },
		});
		expect(again).toMatchObject({
			status: 'complete',
			isReplayed: true,
			projection: { askSummary: 'Send Jonas the signed contract' },
		});
		expect(llm.runLlmObject).not.toHaveBeenCalled();
	});

	it('records ai_off as an incomplete brief without calling the model', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { messageId, threadId } = await seedCaptured(t, { text: TEXT });
		const out = await t.action(internal.mail.interpret.run.interpretMessage, {
			source: { kind: 'mail', id: messageId },
		});
		expect(out).toMatchObject({ status: 'failed', errorCode: 'ai_off' });
		expect(llm.runLlmObject).not.toHaveBeenCalled();
		const brief = await t.run(async (ctx) =>
			ctx.db
				.query('threadBriefs')
				.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
				.first()
		);
		expect(brief?.completeness).toBe('partial');
	});

	it('defers, without spending a retry, when spend admission refuses the model call (Sol r1 F7)', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai']);
		const { messageId } = await seedCaptured(t, { text: TEXT });
		const source = { kind: 'mail' as const, id: messageId };
		llm.runLlmObject.mockRejectedValue(new AdmissionRefusedError('daily_ceiling', 'ceiling'));

		for (let run = 0; run < 5; run++) {
			const out = await t.action(internal.mail.interpret.run.interpretMessage, { source });
			expect(out).toMatchObject({ status: 'failed', errorCode: 'budget' });
		}
		const rows = await t.run(async (ctx) => ctx.db.query('messageInterpretations').collect());
		const counted = rows.find((r) => r.isCounted);
		// No admitted attempt was spent, and the next call may try again at once.
		expect(counted?.retryCount ?? 0).toBe(0);
		expect(counted?.nextRetryAt).toBeDefined();
	});

	describe("the run's one spend hold (Sol r4)", () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});
		const counted = (t: Test) =>
			t.run(async (ctx) =>
				(await ctx.db.query('messageInterpretations').collect()).find((row) => row.isCounted)
			);

		it('a refused hold makes no call and defers the whole run, backed off, with no retry spent', async () => {
			// A ceiling the gate's smallest probe fits under and the run's hold does not.
			vi.stubEnv('AI_SPEND_DAILY_BUDGET_USD', '0.01');
			const t = convexTest(schema, modules);
			rateLimiterTest.register(t);
			await enableFeatures(t, ['ai']);
			await reconcileSpend(t);
			const { messageId } = await seedCaptured(t, { text: TEXT });
			const source = { kind: 'mail' as const, id: messageId };

			const before = Date.now();
			const first = await t.action(internal.mail.interpret.run.interpretMessage, { source });
			expect(first).toMatchObject({
				status: 'failed',
				errorCode: 'budget',
				budgetRefusal: { reason: 'daily_ceiling' },
			});
			if (!('isReplayed' in first)) throw new Error('unreachable');
			expect(first.retryAt).toBeGreaterThanOrEqual(before + 5 * 60 * 1000);
			expect(llm.runLlmObject).not.toHaveBeenCalled();
			expect(await counted(t)).toMatchObject({ retryCount: 0, budgetDeferrals: 1 });
			expect(await t.run((ctx) => ctx.db.query('llmReservations').collect())).toEqual([]);

			// Not due: answered from the row. Due: refused again, the backoff grows.
			const early = await t.action(internal.mail.interpret.run.interpretMessage, { source });
			expect(early).toMatchObject({ isReplayed: true });
			const row = await counted(t);
			if (row) await t.run((ctx) => ctx.db.patch(row._id, { nextRetryAt: 0 }));
			const second = await t.action(internal.mail.interpret.run.interpretMessage, { source });
			if (!('isReplayed' in second)) throw new Error('unreachable');
			expect(second.retryAt).toBeGreaterThanOrEqual(Date.now() + 9 * 60 * 1000);
			expect(await counted(t)).toMatchObject({ retryCount: 0, budgetDeferrals: 2 });
			expect(llm.runLlmObject).not.toHaveBeenCalled();
		});

		it('an admitted run draws every call on its hold, so the verifier cannot be refused', async () => {
			vi.stubEnv('AI_SPEND_DAILY_BUDGET_USD', '10');
			const t = convexTest(schema, modules);
			rateLimiterTest.register(t);
			await enableFeatures(t, ['ai']);
			await reconcileSpend(t);
			const { messageId } = await seedCaptured(t, { text: TEXT });
			const meters: { hasOuterHold: boolean; hasPort: boolean }[] = [];
			llm.runLlmObject.mockImplementation(
				async (opts: {
					schema: unknown;
					meter: { hasOuterHold: boolean; admission?: unknown };
				}) => {
					meters.push({ hasOuterHold: opts.meter.hasOuterHold, hasPort: !!opts.meter.admission });
					// While the run runs, its one hold is outstanding.
					const holds = await t.run((ctx) => ctx.db.query('llmReservations').collect());
					expect(holds).toEqual([
						expect.objectContaining({ status: 'held', task: 'mail.extract' }),
					]);
					return opts.schema === briefModelSchema
						? { object: modelOutput('s0') }
						: { object: { verdicts: [{ claimId: 'item:0', verdict: 'supported' }] } };
				}
			);

			const out = await t.action(internal.mail.interpret.run.interpretMessage, {
				source: { kind: 'mail', id: messageId },
			});

			expect(out).toMatchObject({ status: 'complete' });
			// The extraction and the verifier: neither reserves on its own, so
			// neither can be refused once the run is admitted.
			expect(meters).toEqual([
				{ hasOuterHold: true, hasPort: false },
				{ hasOuterHold: true, hasPort: false },
			]);
			const [hold] = await t.run((ctx) => ctx.db.query('llmReservations').collect());
			expect(hold).toMatchObject({ status: 'settled' });
			// Neither call reported usage: each is charged at its own keyed bound,
			// the verifier's far below the extraction's, the total within the hold
			// (Sol r5 F2).
			const requestRows = (await t.run((ctx) => ctx.db.query('llmUsageEvents').collect())).filter(
				(r) => r.reservationId === hold?.reservationId && r.feature !== 'admission_settlement'
			);
			const boundOf = (r: { requestId?: string; attempt?: number }) =>
				hold?.requestBounds?.find((b) => b.requestId === r.requestId && b.attempt === r.attempt)
					?.microusd;
			const extractBound = boundOf(requestRows.find((r) => r.feature === 'interpret')!);
			const verifyBound = boundOf(requestRows.find((r) => r.feature === 'interpret_verify')!);
			expect(extractBound).toBeGreaterThan(0);
			expect(verifyBound).toBeGreaterThan(0);
			expect(verifyBound!).toBeLessThan(extractBound!);
			expect(hold?.settledMicrousd).toBe(extractBound! + verifyBound!);
			expect(hold!.settledMicrousd!).toBeLessThanOrEqual(hold!.heldMicrousd);
			const rows = await t.run((ctx) => ctx.db.query('llmUsageEvents').collect());
			expect(
				rows.filter(
					(r) => r.reservationId === hold?.reservationId && r.feature !== 'admission_settlement'
				)
			).toHaveLength(2);
		});

		it('an AI-off gate counts no attempt', async () => {
			const t = convexTest(schema, modules);
			rateLimiterTest.register(t);
			await enableFeatures(t, ['ai']);
			const { messageId } = await seedCaptured(t, { text: TEXT });
			const source = { kind: 'mail' as const, id: messageId };
			// One admitted attempt that failed: retryCount 1, a repair due later.
			llm.runLlmObject.mockRejectedValue(new Error('provider down'));
			await t.action(internal.mail.interpret.run.interpretMessage, { source });
			expect(await counted(t)).toMatchObject({ retryCount: 1 });

			// AI turned off; the repair comes due: refused at the gate, no call, no attempt.
			await t.run(async (ctx) => {
				const settings = await ctx.db.query('instanceSettings').first();
				if (settings) {
					await ctx.db.patch(settings._id, {
						featureFlags: { ...settings.featureFlags, ai: false },
					});
				}
				const flags = await ctx.db.query('featureFlagSettings').first();
				if (flags) {
					await ctx.db.patch(flags._id, { featureFlags: { ...flags.featureFlags, ai: false } });
				}
				const row = (await ctx.db.query('messageInterpretations').collect()).find(
					(r) => r.isCounted
				);
				if (row) await ctx.db.patch(row._id, { nextRetryAt: 0 });
			});
			llm.runLlmObject.mockClear();
			const out = await t.action(internal.mail.interpret.run.interpretMessage, { source });
			expect(out).toMatchObject({ status: 'failed', errorCode: 'ai_off' });
			expect(llm.runLlmObject).not.toHaveBeenCalled();
			expect(await counted(t)).toMatchObject({ retryCount: 1 });
		});

		it('reports a verifier refusal as an ordinary incomplete run, with the refusal (Sol r4 F2)', async () => {
			const t = convexTest(schema, modules);
			rateLimiterTest.register(t);
			await enableFeatures(t, ['ai']);
			const { messageId } = await seedCaptured(t, { text: TEXT });
			llm.runLlmObject.mockImplementation(async ({ schema }: { schema: unknown }) => {
				if (schema === briefModelSchema) return { object: modelOutput('s0') };
				throw new AdmissionRefusedError('daily_ceiling', 'ceiling');
			});
			const out = await t.action(internal.mail.interpret.run.interpretMessage, {
				source: { kind: 'mail', id: messageId },
			});
			expect(out).toMatchObject({
				status: 'partial',
				errorCode: 'verify',
				budgetRefusal: { reason: 'daily_ceiling', limit: 'ceiling' },
			});
			expect(await counted(t)).toMatchObject({ retryCount: 1 });
		});
	});

	it('fails soft when the model throws', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai']);
		llm.runLlmObject.mockRejectedValue(new Error('provider down'));
		const { messageId } = await seedCaptured(t, { text: TEXT });
		const out = await t.action(internal.mail.interpret.run.interpretMessage, {
			source: { kind: 'mail', id: messageId },
		});
		expect(out).toMatchObject({ status: 'failed', errorCode: 'model_error' });
	});

	it('skips a muted thread and backfilled mail without a model call', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai']);
		const { messageId } = await seedCaptured(t, { text: TEXT, isLive: false });
		const source = { kind: 'mail' as const, id: messageId };
		const backfill = await t.action(internal.mail.interpret.run.interpretMessage, { source });
		expect(backfill).toMatchObject({ status: 'skipped', errorCode: 'not_live' });
		// A retry decides on the enqueue snapshot: a caller claiming "live" changes nothing.
		expect(
			await t.action(internal.mail.interpret.run.interpretMessage, { source, isLive: true })
		).toMatchObject({ status: 'skipped', isReplayed: true });

		const second = await seedMailThread(t, { text: TEXT, address: 'two@owlat.test' });
		await t.run(async (ctx) => ctx.db.patch(second.threadId, { mutedAt: 1 }));
		await t.run(async (ctx) =>
			captureInterpretSource(ctx, { source: { kind: 'mail', id: second.messageId }, isLive: true })
		);
		const muted = await t.action(internal.mail.interpret.run.interpretMessage, {
			source: { kind: 'mail', id: second.messageId },
		});
		expect(muted).toMatchObject({ status: 'skipped', errorCode: 'muted' });
		expect(llm.runLlmObject).not.toHaveBeenCalled();
	});

	it('does not interpret a message without an enqueue snapshot (F15)', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai']);
		const { messageId } = await seedMailThread(t, { text: TEXT });
		const out = await t.action(internal.mail.interpret.run.interpretMessage, {
			source: { kind: 'mail', id: messageId },
			isLive: true,
		});
		expect(out).toMatchObject({ status: 'skipped', errorCode: 'no_snapshot' });
		expect(llm.runLlmObject).not.toHaveBeenCalled();
	});

	it('reports a partial run as partial, and repairs it once its retry is due (F2)', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai']);
		// The first verifier call fails: the run is partial ('verify').
		llm.runLlmObject.mockImplementation(async ({ schema }: { schema: unknown }) => {
			if (schema === briefModelSchema) return { object: modelOutput('s0') };
			throw new Error('verifier down');
		});
		const { messageId, threadId } = await seedCaptured(t, { text: TEXT });
		const source = { kind: 'mail' as const, id: messageId };
		const first = await t.action(internal.mail.interpret.run.interpretMessage, { source });
		expect(first).toMatchObject({ status: 'partial', isReplayed: false, errorCode: 'verify' });
		if (!('isReplayed' in first)) throw new Error('unreachable');
		expect(first.retryAt).toBeGreaterThan(Date.now());

		// Not due yet: reported as partial, never as a bare replay.
		llm.runLlmObject.mockClear();
		const early = await t.action(internal.mail.interpret.run.interpretMessage, { source });
		expect(early).toMatchObject({ status: 'partial', isReplayed: true });
		expect(llm.runLlmObject).not.toHaveBeenCalled();

		// Due: the repair runs, the verifier answers, the thread is rebuilt without duplicates.
		await t.run(async (ctx) => {
			const row = await ctx.db.query('messageInterpretations').first();
			if (row) await ctx.db.patch(row._id, { nextRetryAt: 0 });
		});
		llm.runLlmObject.mockImplementation(async ({ schema }: { schema: unknown }) =>
			schema === briefModelSchema
				? { object: modelOutput('s0') }
				: { object: { verdicts: [{ claimId: 'item:0', verdict: 'supported' }] } }
		);
		const repaired = await t.action(internal.mail.interpret.run.interpretMessage, { source });
		expect(repaired).toMatchObject({ status: 'complete', isReplayed: false });
		const items = await t.run(async (ctx) =>
			ctx.db
				.query('threadItems')
				.withIndex('by_mail_thread_and_status', (q) => q.eq('mailThreadId', threadId))
				.collect()
		);
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ verify: 'passed', status: 'open' });
		const brief = await t.run(async (ctx) => ctx.db.query('threadBriefs').first());
		expect(brief).toMatchObject({
			completeness: 'complete',
			sourceCounts: { complete: 1, partial: 0 },
		});
	});

	it('drops a claim the verifier rejects', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai']);
		llm.runLlmObject.mockImplementation(async ({ schema }: { schema: unknown }) =>
			schema === briefModelSchema
				? { object: modelOutput('s0') }
				: { object: { verdicts: [{ claimId: 'item:0', verdict: 'unsupported' }] } }
		);
		const { messageId } = await seedCaptured(t, { text: TEXT });
		const out = await t.action(internal.mail.interpret.run.interpretMessage, {
			source: { kind: 'mail', id: messageId },
		});
		expect(out).toMatchObject({ status: 'complete', createdItemIds: [] });
	});

	it('checks the body on every attempt and records a body that keeps changing (round 2 F1)', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai']);
		const { messageId, threadId } = await seedCaptured(t, { text: TEXT });
		let edits = 0;
		llm.runLlmObject.mockImplementation(async ({ schema }: { schema: unknown }) => {
			if (schema === briefModelSchema) {
				// The body changes while every extraction is in flight.
				edits++;
				await t.run(async (ctx) =>
					ctx.db.patch(messageId, { textBodyInline: `${TEXT} (edit ${edits})` })
				);
				return { object: modelOutput('s0') };
			}
			return { object: { verdicts: [{ claimId: 'item:0', verdict: 'supported' }] } };
		});
		const out = await t.action(internal.mail.interpret.run.interpretMessage, {
			source: { kind: 'mail', id: messageId },
		});
		expect(out).toMatchObject({ status: 'failed', errorCode: 'source_changed' });
		expect(edits).toBe(2);
		const items = await t.run(async (ctx) =>
			ctx.db
				.query('threadItems')
				.withIndex('by_mail_thread_and_status', (q) => q.eq('mailThreadId', threadId))
				.collect()
		);
		expect(items).toEqual([]);
	});

	it('re-extracts when the mailbox changes scope under the run (round 2 F6)', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai']);
		const { messageId, threadId, mailboxId } = await seedCaptured(t, { text: TEXT });
		const schemas: unknown[] = [];
		llm.runLlmObject.mockImplementation(async ({ schema }: { schema: unknown }) => {
			schemas.push(schema);
			if (schema === briefModelSchema) {
				// The owner converts the mailbox to a team inbox meanwhile.
				await t.run(async (ctx) => ctx.db.patch(mailboxId, { scope: 'shared' }));
				return { object: modelOutput('s0') };
			}
			if (schema === actionsModelSchema) {
				const { latest: _l, facts: _f, ...actions } = modelOutput('s0');
				return { object: { ...actions, mode: 'actions' } };
			}
			return { object: { verdicts: [{ claimId: 'item:0', verdict: 'supported' }] } };
		});
		const out = await t.action(internal.mail.interpret.run.interpretMessage, {
			source: { kind: 'mail', id: messageId },
		});
		expect(out).toMatchObject({ status: 'complete' });
		expect(schemas.filter((x) => x === briefModelSchema)).toHaveLength(1);
		expect(schemas.filter((x) => x === actionsModelSchema)).toHaveLength(1);
		const rows = await t.run(async (ctx) => ctx.db.query('messageInterpretations').collect());
		expect(rows.every((r) => r.mode === 'actions')).toBe(true);
		const brief = await t.run(async (ctx) =>
			ctx.db
				.query('threadBriefs')
				.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
				.first()
		);
		expect(brief?.mode).toBe('actions');
		expect(await t.run(async (ctx) => ctx.db.query('threadFacts').collect())).toEqual([]);
	});

	it('re-extracts an older revision that is no longer current (round 3 F2)', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai']);
		const { messageId } = await seedCaptured(t, { text: TEXT });
		const source = { kind: 'mail' as const, id: messageId };
		const setBody = (text: string) =>
			t.run(async (ctx) => ctx.db.patch(messageId, { textBodyInline: text }));
		const extractions = () =>
			llm.runLlmObject.mock.calls.filter((c) => c[0]?.schema === briefModelSchema).length;
		await t.action(internal.mail.interpret.run.interpretMessage, { source }); // A
		await setBody(`${TEXT} Thanks, Jonas.`);
		await t.action(internal.mail.interpret.run.interpretMessage, { source }); // B
		await setBody(TEXT);
		const again = await t.action(internal.mail.interpret.run.interpretMessage, { source }); // A
		expect(again).toMatchObject({ status: 'complete', isReplayed: false });
		expect(extractions()).toBe(3);
		const rows = await t.run(async (ctx) => ctx.db.query('messageInterpretations').collect());
		expect(rows.filter((r) => r.isCurrent)).toHaveLength(1);
		const current = rows.find((r) => r.isCurrent);
		const first = rows.reduce((a, b) => (a._creationTime < b._creationTime ? a : b));
		expect(current?._id).toBe(first._id);
	});

	it('re-extracts after the thread changed mode instead of reusing a brief extraction (round 3 F3)', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai']);
		const { messageId, mailboxId } = await seedCaptured(t, { text: TEXT });
		const source = { kind: 'mail' as const, id: messageId };
		llm.runLlmObject.mockImplementation(async ({ schema }: { schema: unknown }) => {
			if (schema === briefModelSchema) return { object: modelOutput('s0') };
			if (schema === actionsModelSchema) {
				const { latest: _l, facts: _f, ...actions } = modelOutput('s0');
				return { object: { ...actions, mode: 'actions' } };
			}
			return { object: { verdicts: [{ claimId: 'item:0', verdict: 'supported' }] } };
		});
		await t.action(internal.mail.interpret.run.interpretMessage, { source });
		await t.run(async (ctx) => ctx.db.patch(mailboxId, { scope: 'shared' }));
		const out = await t.action(internal.mail.interpret.run.interpretMessage, { source });
		expect(out).toMatchObject({ status: 'complete', isReplayed: false });
		const rows = await t.run(async (ctx) => ctx.db.query('messageInterpretations').collect());
		expect(rows.find((r) => r.isCurrent)?.mode).toBe('actions');
	});

	it('records every failed repair and never spends retries on gate refusals (round 3 F4)', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { messageId, threadId } = await seedCaptured(t, { text: TEXT });
		const source = { kind: 'mail' as const, id: messageId };
		// 1. AI is off: a gate refusal, retried freely.
		const off = await t.action(internal.mail.interpret.run.interpretMessage, { source });
		expect(off).toMatchObject({ status: 'failed', errorCode: 'ai_off' });
		// 2. AI on, the verifier fails: partial, with the full retry budget left.
		await enableFeatures(t, ['ai']);
		llm.runLlmObject.mockImplementation(async ({ schema }: { schema: unknown }) => {
			if (schema === briefModelSchema) return { object: modelOutput('s0') };
			throw new Error('verifier down');
		});
		const partial = await t.action(internal.mail.interpret.run.interpretMessage, { source });
		expect(partial).toMatchObject({ status: 'partial', errorCode: 'verify' });
		if (!('isReplayed' in partial)) throw new Error('unreachable');
		expect(partial.retryAt).toBeDefined();
		const rows = await t.run(async (ctx) => ctx.db.query('messageInterpretations').collect());
		// One admitted attempt (the model ran); the gate refusal before it counted nothing.
		expect(rows.find((r) => r.isCounted)?.retryCount).toBe(1);
		// 3. The repair is due and the model fails: recorded and counted, the good read kept.
		await t.run(async (ctx) => {
			const row = (await ctx.db.query('messageInterpretations').collect()).find((r) => r.isCounted);
			if (row) await ctx.db.patch(row._id, { nextRetryAt: 0 });
		});
		llm.runLlmObject.mockRejectedValue(new Error('provider down'));
		const failed = await t.action(internal.mail.interpret.run.interpretMessage, { source });
		expect(failed).toMatchObject({ status: 'failed', errorCode: 'model_error' });
		if (!('isReplayed' in failed)) throw new Error('unreachable');
		expect(failed.retryAt).toBeDefined();
		const brief = await t.run(async (ctx) =>
			ctx.db
				.query('threadBriefs')
				.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
				.first()
		);
		expect(brief?.sourceCounts).toMatchObject({ failed: 1, partial: 0 });
		const items = await t.run(async (ctx) => ctx.db.query('threadItems').collect());
		expect(items).toHaveLength(1);
	});
});
