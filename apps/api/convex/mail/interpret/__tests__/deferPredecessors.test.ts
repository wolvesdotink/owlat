/**
 * D10 with Sol r2 F1: a source turning eager reads its thread's EARLIER
 * deferred sources first. An earlier message (an invoice) can hold the item a
 * later one cancels or completes; the later run reads only items that exist,
 * so the earlier one is promoted (outstanding again) and interpreted first,
 * oldest first, for an inbound and for an outbound (sent) eager source.
 */

import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { internal } from '../../../_generated/api';
import type { Id } from '../../../_generated/dataModel';
import { enableFeatures } from '../../../__tests__/factories';
import { briefModelSchema } from '../schema';
import { addMessageToThread, modules, seedMailThread, type Test } from './interpret.testlib';
import { captureInterpretSource } from '../sources';
import { deferSource } from '../outstanding';
import type { InterpretationSource } from '../../../lib/validators/threadBrief';

const llm = vi.hoisted(() => ({ runLlmObject: vi.fn(), spend: vi.fn() }));

vi.mock('../../../lib/llm/dispatch', () => ({ runLlmObject: llm.runLlmObject }));
vi.mock('../../../lib/llmProvider', () => ({
	resolveLanguageModel: vi.fn(async () => ({ modelId: 'stub-model' })),
}));
vi.mock('../../../analytics/llmUsage', () => ({ recordLlmSpend: llm.spend }));

const INVOICE = 'Invoice 77: could you send me the signed contract by Friday?';
const CANCEL = 'Never mind, no need to send me the signed contract by Friday anymore.';
const SENT = 'Here it is: you asked me to send me the signed contract by Friday, attached.';

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

/** Which message each interpretation prompt read, in call order. */
const readOrder = () =>
	llm.runLlmObject.mock.calls
		.filter(([opts]) => (opts as { schema: unknown }).schema === briefModelSchema)
		.map(([opts]) => {
			const text = JSON.stringify(opts);
			return text.includes('Invoice 77')
				? 'invoice'
				: text.includes('Never mind')
					? 'cancel'
					: text.includes('Here it is')
						? 'sent'
						: '?';
		});

beforeEach(() => {
	llm.runLlmObject.mockReset();
	llm.spend.mockReset();
	llm.runLlmObject.mockImplementation(async ({ schema }: { schema: unknown }) => {
		if (schema === briefModelSchema) {
			return {
				object: modelOutput('s0'),
				tokenUsage: { totalTokens: 10 },
				modelUsed: 'stub-model',
			};
		}
		return {
			object: { verdicts: [{ claimId: 'item:0', verdict: 'supported' }] },
			tokenUsage: { totalTokens: 2 },
			modelUsed: 'stub-model',
		};
	});
});

const T0 = Date.UTC(2026, 9, 7, 9, 0);

/** An invoice thread whose first message was deferred (display-only). */
async function seedDeferredInvoice(t: Test) {
	const seeded = await seedMailThread(t, { text: INVOICE });
	await t.run(async (ctx) => {
		await captureInterpretSource(ctx, {
			source: { kind: 'mail', id: seeded.messageId },
			isLive: true,
		});
		await deferSource(ctx, `mail:${seeded.messageId}`, 'display_only');
	});
	return seeded;
}

async function snapshotOf(t: Test, source: InterpretationSource) {
	return t.run((ctx) =>
		ctx.db
			.query('interpretSources')
			.withIndex('by_source_key', (q) => q.eq('sourceKey', `${source.kind}:${source.id}`))
			.first()
	);
}

async function capture(t: Test, source: InterpretationSource) {
	await t.run((ctx) => captureInterpretSource(ctx, { source, isLive: true }));
}

describe('D10: an eager run reads its deferred predecessors first (Sol r2 F1)', () => {
	it('inbound: the later message is read after the deferred invoice', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai']);
		const { mailboxId, threadId, messageId: invoiceId } = await seedDeferredInvoice(t);
		const cancelId = await addMessageToThread(
			t,
			{ mailboxId, threadId },
			{ text: CANCEL, receivedAt: T0 + 60_000 }
		);
		const cancel = { kind: 'mail' as const, id: cancelId };
		await capture(t, cancel);

		await t.action(internal.mail.interpret.run.interpretMessage, { source: cancel });

		expect(readOrder()).toEqual(['invoice', 'cancel']);
		const invoice = await snapshotOf(t, { kind: 'mail', id: invoiceId });
		expect(invoice?.isDeferred).toBeUndefined();
		expect(invoice?.isOutstanding).toBeUndefined();
		const brief = await t.run((ctx) =>
			ctx.db
				.query('threadBriefs')
				.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
				.first()
		);
		expect(brief?.deferredSources).toBeUndefined();
		expect(brief?.pendingSources).toBeUndefined();
	});

	it('outbound: a sent reply is read after the deferred invoice', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai']);
		const { mailboxId, threadId } = await seedDeferredInvoice(t);
		const sentId = await addMessageToThread(
			t,
			{ mailboxId, threadId },
			{
				text: SENT,
				receivedAt: T0 + 60_000,
				fromAddress: 'me@owlat.test',
			}
		);
		await t.run((ctx) => ctx.db.patch(sentId, { outbound: { state: 'sent', recipients: [] } }));
		const sent = { kind: 'outboundMail' as const, id: sentId };
		await capture(t, sent);

		await t.action(internal.mail.interpret.outboundRun.interpretSent, { source: sent });

		expect(readOrder()).toEqual(['invoice', 'sent']);
	});

	it('a deferred message LATER than the eager one stays deferred', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai']);
		const { mailboxId, threadId, messageId: firstId } = await seedMailThread(t, { text: INVOICE });
		const laterId = await addMessageToThread(
			t,
			{ mailboxId, threadId },
			{ text: CANCEL, receivedAt: T0 + 60_000 }
		);
		await t.run(async (ctx) => {
			await captureInterpretSource(ctx, { source: { kind: 'mail', id: laterId }, isLive: true });
			await deferSource(ctx, `mail:${laterId}`, 'display_only');
		});
		const first = { kind: 'mail' as const, id: firstId };
		await capture(t, first);

		await t.action(internal.mail.interpret.run.interpretMessage, { source: first });

		expect(readOrder()).toEqual(['invoice']);
		expect((await snapshotOf(t, { kind: 'mail', id: laterId }))?.isDeferred).toBe(true);
	});

	it('promotes several, oldest first', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, threadId, messageId: a } = await seedDeferredInvoice(t);
		const b = await addMessageToThread(
			t,
			{ mailboxId, threadId },
			{ text: INVOICE, receivedAt: T0 + 30_000 }
		);
		const c = await addMessageToThread(
			t,
			{ mailboxId, threadId },
			{ text: CANCEL, receivedAt: T0 + 60_000 }
		);
		await t.run(async (ctx) => {
			await captureInterpretSource(ctx, { source: { kind: 'mail', id: b }, isLive: true });
			await deferSource(ctx, `mail:${b}`, 'display_only');
			await captureInterpretSource(ctx, { source: { kind: 'mail', id: c }, isLive: true });
		});
		const promoted = await t.mutation(internal.mail.interpret.defer.promoteDeferredPredecessors, {
			source: { kind: 'mail', id: c },
		});
		expect(promoted).toEqual([
			{ kind: 'mail', id: a },
			{ kind: 'mail', id: b },
		]);
		for (const id of [a, b] as Id<'mailMessages'>[]) {
			expect(await snapshotOf(t, { kind: 'mail', id })).toMatchObject({ isOutstanding: true });
		}
	});
});
