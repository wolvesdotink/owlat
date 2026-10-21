/**
 * Read on arrival, #1384: payment and legal mail is never buried in the
 * digest or updates. An exact-wording candidate (changed bank details, a
 * legal notice, an invoice with payment details) is read in full when the
 * budget and the owner limit allow, and placed in Today either way, whatever
 * the sender's digest status, a rule, a sender override or the category say.
 * The person's explicit choices still win: a message-scope Fix, an
 * auto-archived sender. A candidate read the text-blind admission let through
 * uncharged takes its owner token at the depth decision.
 */

import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { api, internal } from '../../../_generated/api';
import type { Doc, Id } from '../../../_generated/dataModel';
import { enableFeatures } from '../../../__tests__/factories';
import { detectExactWording } from '@owlat/shared/exactWordingDetector';
import { briefModelSchema } from '../schema';
import { gistOutputSchema } from '../gist';
import { modules, seedMailThread, type Test } from './interpret.testlib';
import { captureInterpretSource, loadInterpretSource } from '../sources';
import { AdmissionRefusedError } from '../../../lib/llm/admissionPort';
import { noteRecordCategory, writeArrivalRecord } from '../../arrival/records';
import { refreshArrivalProjection } from '../../arrival/projection';
import { rateLimiter } from '../../../lib/rateLimiter';
import { senderKeyOf } from '../../senders/profiles';

const llm = vi.hoisted(() => ({ runLlmObject: vi.fn(), refuseNext: false }));

vi.mock('../../../lib/llm/dispatch', async () => {
	const { metered } = await import('../../../analytics/__tests__/meteredDispatch.testlib');
	return { runLlmObject: metered((opts: unknown) => llm.runLlmObject(opts)) };
});
vi.mock('../../../lib/llmProvider', () => ({
	resolveLanguageModel: vi.fn(async () => ({ modelId: 'stub-model' })),
}));

vi.mock('../../../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	const session = { userId: 'user-A', role: 'owner' as const, activeOrganizationId: 'org-1' };
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getBetterAuthSessionWithRole: vi.fn(async () => session),
	};
});

const PAYMENT = 'Please note our new bank details for all future payments to us.';
const LEGAL = 'This is a notice of termination of your contract, effective 31 December.';
const INVOICE = 'Your invoice INV-204 is attached. Amount due: 120 EUR, payable within 14 days.';
const NOTICE = 'Your parcel was delivered to the front door at 10:42. Thanks for shopping with us.';

const CANDIDATES = [
	['a payment-details change', PAYMENT],
	['a termination notice', LEGAL],
	['an invoice with payment details', INVOICE],
] as const;

const callsFor = (schemaRef: unknown) =>
	llm.runLlmObject.mock.calls.filter(([opts]) => (opts as { schema: unknown }).schema === schemaRef)
		.length;
const extractions = () => callsFor(briefModelSchema);
const gistCalls = () => callsFor(gistOutputSchema);

beforeEach(() => {
	llm.refuseNext = false;
	llm.runLlmObject.mockReset();
	llm.runLlmObject.mockImplementation(async ({ schema: s }: { schema: unknown }) => {
		if (llm.refuseNext) throw new AdmissionRefusedError('daily_ceiling', 'stub');
		if (s === briefModelSchema) {
			return {
				object: {
					mode: 'brief',
					items: [],
					transitions: [],
					replyIntent: 'fyi',
					urgency: 'normal',
					meetingIntent: null,
					coverage: { segmentsRead: ['s0'], uncertain: false, overflow: false },
					latest: { en: [], de: [] },
					facts: [],
				},
				tokenUsage: undefined,
				modelUsed: 'stub-model',
			};
		}
		if (s === gistOutputSchema) {
			return {
				object: { spans: [{ segment: 's0', quote: NOTICE }] },
				tokenUsage: undefined,
				modelUsed: 'stub-model',
			};
		}
		return { object: { verdicts: [] }, tokenUsage: undefined, modelUsed: 'stub-model' };
	});
});

type Category = NonNullable<Doc<'mailArrivalRecords'>['category']>;

interface Burial {
	senderStatus?: Doc<'mailSenderProfiles'>['status'];
	senderOverride?: Doc<'mailSenderProfiles'>['placementOverride'];
	rulePlacement?: Doc<'mailArrivalRecords'>['rulePlacement'];
	threadOverride?: 'digest' | 'updates' | 'archived';
}

function setup() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

/** A delivered message as delivery leaves it, with the digest choice that would bury it. */
async function arrive(t: Test, text: string, category: Category, burial: Burial = {}) {
	await enableFeatures(t, ['ai']);
	const seeded = await seedMailThread(t, { text, isReadOnArrival: true });
	const source = { kind: 'mail' as const, id: seeded.messageId };
	await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.patch(seeded.threadId, {
			category: { label: category, source: 'heuristic', classifiedAt: now },
			...(burial.threadOverride
				? {
						placementOverride: {
							placement: burial.threadOverride,
							setAt: now,
							operationId: await ctx.db.insert('mailArrivalOperations', {
								mailboxId: seeded.mailboxId,
								kind: 'fix',
								actor: 'user',
								changeCount: 0,
								status: 'applied',
								createdAt: now,
								expiresAt: now + 1,
							}),
						},
					}
				: {}),
		});
		if (burial.senderStatus || burial.senderOverride) {
			const key = senderKeyOf('jonas@example.com');
			await ctx.db.insert('mailSenderProfiles', {
				mailboxId: seeded.mailboxId,
				senderDigest: key.senderDigest,
				address: key.address,
				status: burial.senderStatus ?? 'keep',
				statusSource: 'user',
				...(burial.senderOverride ? { placementOverride: burial.senderOverride } : {}),
				weekAnchor: 0,
				deliveredWeeks: [],
				openedWeeks: [],
				unusedDraftStreak: 0,
				createdAt: now,
				updatedAt: now,
			});
		}
		await writeArrivalRecord(ctx, (await ctx.db.get(seeded.messageId))!, {
			isLive: true,
			...(burial.rulePlacement ? { rulePlacement: burial.rulePlacement } : {}),
		});
		await captureInterpretSource(ctx, { source, isLive: true });
		// Delivery projects the thread before any read (`afterInsert.ts`).
		await refreshArrivalProjection(ctx, seeded.threadId);
	});
	return { ...seeded, source };
}

async function snapshot(t: Test, messageId: Id<'mailMessages'>) {
	return t.run(async (ctx) => {
		const message = (await ctx.db.get(messageId))!;
		return {
			source: await loadInterpretSource(ctx, { kind: 'mail', id: messageId }),
			thread: (await ctx.db.get(message.threadId))!,
			record: await ctx.db
				.query('mailArrivalRecords')
				.withIndex('by_message', (q) => q.eq('messageId', messageId))
				.first(),
		};
	});
}

const run = (t: Test, source: { kind: 'mail'; id: Id<'mailMessages'> }) =>
	t.action(internal.mail.interpret.run.interpretMessage, { source });

async function exhaustOwnerBucket(t: Test, mailboxId: Id<'mailboxes'>) {
	await t.run(async (ctx) => {
		const owner = (await ctx.db.get(mailboxId))!.userId;
		for (let i = 0; i < 80; i++) {
			if (!(await rateLimiter.limit(ctx, 'arrivalReadPerOwner', { key: owner })).ok) break;
		}
	});
}

/** The owner's tokens left in the `arrivalReadPerOwner` bucket (60 when untouched). */
async function ownerTokens(t: Test, mailboxId: Id<'mailboxes'>) {
	return t.run(async (ctx) => {
		const owner = (await ctx.db.get(mailboxId))!.userId;
		return (await rateLimiter.getValue(ctx, 'arrivalReadPerOwner', { key: owner })).value;
	});
}

/** Every digest choice that buries a display-only message, with the category it comes with. */
const BURIALS: Array<[string, Category, Burial]> = [
	['a digest sender', 'person', { senderStatus: 'digest' }],
	['a learned digest sender of a newsletter', 'newsletter', { senderStatus: 'digest' }],
	['a sendToDigest rule', 'notification', { rulePlacement: 'digest' }],
	['a placeInUpdates rule', 'person', { rulePlacement: 'updates' }],
	['a sender override to updates', 'receipt', { senderOverride: 'updates' }],
	['the newsletter category', 'newsletter', {}],
	['the promotion category', 'promotion', {}],
	['the notification category', 'notification', {}],
	['the receipt category', 'receipt', {}],
];

describe('#1384: the text really is a candidate', () => {
	it.each(CANDIDATES)('%s', (_name, text) => {
		expect(detectExactWording({ subject: 'hello', text }).length).toBeGreaterThan(0);
	});
});

describe('#1384: an exact-wording candidate is read in full and placed in Today', () => {
	for (const [what, text] of CANDIDATES) {
		it.each(BURIALS)(`${what} despite %s`, async (_name, category, burial) => {
			const t = setup();
			const { source, messageId, mailboxId } = await arrive(t, text, category, burial);
			await run(t, source);
			expect(extractions()).toBe(1);
			expect(gistCalls()).toBe(0);
			const { source: row, record, thread } = await snapshot(t, messageId);
			expect(record).toMatchObject({ depth: 'full', isExactWordingCandidate: true });
			expect(record?.reasonKeys.map((r) => r.key)).toContain('arrival.reason.exactWording');
			expect(thread.arrival).toMatchObject({ placement: 'today', depth: 'full' });
			expect(thread.digestPendingSince).toBeUndefined();
			expect(row?.readOutcome).toBeUndefined();
			// The read took one owner token (at admission or, when the text-blind
			// admission counted it, at the depth decision).
			const left = await ownerTokens(t, mailboxId);
			expect(left).toBeLessThan(59.5);
			expect(left).toBeGreaterThan(58.5);
		});
	}

	it('the same mail without the wording is still counted into the digest', async () => {
		const t = setup();
		const { source, messageId, mailboxId } = await arrive(t, NOTICE, 'person', {
			senderStatus: 'digest',
		});
		await run(t, source);
		expect(llm.runLlmObject).not.toHaveBeenCalled();
		const { record, thread } = await snapshot(t, messageId);
		expect(record).toMatchObject({ depth: 'count' });
		expect(record?.isExactWordingCandidate).toBeUndefined();
		expect(thread.arrival).toMatchObject({ placement: 'digest' });
		expect(thread.digestPendingSince).toBeDefined();
		// Counted without a model call: no owner token taken.
		expect(await ownerTokens(t, mailboxId)).toBe(60);
	});

	it('leaving the digest clears the thread from the next digest', async () => {
		const t = setup();
		const { source, messageId } = await arrive(t, PAYMENT, 'newsletter', {
			senderStatus: 'digest',
		});
		// Before the read the text-blind projection had it pending for the digest.
		expect((await snapshot(t, messageId)).thread.digestPendingSince).toBeDefined();
		await run(t, source);
		const { thread } = await snapshot(t, messageId);
		expect(thread.arrival?.placement).toBe('today');
		expect(thread.digestPendingSince).toBeUndefined();
	});

	it('a later category refinement keeps it in Today', async () => {
		const t = setup();
		const { source, messageId, threadId } = await arrive(t, INVOICE, 'person');
		await run(t, source);
		await t.run((ctx) => noteRecordCategory(ctx, threadId, { label: 'newsletter', source: 'llm' }));
		const { thread, record } = await snapshot(t, messageId);
		expect(record).toMatchObject({ category: 'newsletter', isExactWordingCandidate: true });
		expect(thread.arrival?.placement).toBe('today');
		expect(thread.digestPendingSince).toBeUndefined();
	});

	it('Why here? names the wording as what placed it', async () => {
		const t = setup();
		const { source, threadId } = await arrive(t, LEGAL, 'notification', {
			senderStatus: 'digest',
		});
		await run(t, source);
		const why = await t.query(api.mail.arrival.explain.forThread, { threadId });
		expect(why).toMatchObject({ placement: 'today', decidedBy: 'exact_wording', depth: 'full' });
		expect(why?.reasons.map((r) => r.key)).toContain('arrival.reason.exactWording');
	});
});

describe('#1384: without an allowance it is counted, and still placed in Today', () => {
	it('a spend refusal counts it in Today', async () => {
		const t = setup();
		const { source, messageId } = await arrive(t, PAYMENT, 'person', { senderStatus: 'digest' });
		llm.refuseNext = true;
		expect(await run(t, source)).toMatchObject({ errorCode: 'arrival_settled_count' });
		const { record, thread, source: row } = await snapshot(t, messageId);
		expect(row).toMatchObject({ readOutcome: 'skipped', depth: 'count', isUpgradeable: true });
		expect(record).toMatchObject({ degradedBy: 'budget', isExactWordingCandidate: true });
		expect(thread.arrival).toMatchObject({ placement: 'today', depth: 'count' });
		expect(thread.digestPendingSince).toBeUndefined();
	});

	it('over the owner limit, a candidate admission let through uncharged is counted at the decision', async () => {
		const t = setup();
		const { source, messageId, mailboxId } = await arrive(t, LEGAL, 'newsletter', {
			senderStatus: 'digest',
		});
		await exhaustOwnerBucket(t, mailboxId);
		expect(await run(t, source)).toMatchObject({ errorCode: 'arrival_settled_count' });
		expect(llm.runLlmObject).not.toHaveBeenCalled();
		const { record, thread, source: row } = await snapshot(t, messageId);
		expect(row).toMatchObject({
			readOutcome: 'skipped',
			depth: 'count',
			isUpgradeable: true,
			skipReason: { key: 'arrival.reason.ownerLimit' },
		});
		expect(record).toMatchObject({ degradedBy: 'owner_limit', isExactWordingCandidate: true });
		expect(thread.arrival).toMatchObject({ placement: 'today', depth: 'count' });
	});

	it('over the owner limit at admission, its text is still screened and placed in Today', async () => {
		const t = setup();
		const { source, messageId, mailboxId } = await arrive(t, INVOICE, 'notification');
		await exhaustOwnerBucket(t, mailboxId);
		expect(await run(t, source)).toMatchObject({ errorCode: 'arrival_settled_count' });
		expect(llm.runLlmObject).not.toHaveBeenCalled();
		const { record, thread, source: row } = await snapshot(t, messageId);
		expect(row).toMatchObject({ skipReason: { key: 'arrival.reason.ownerLimit' } });
		expect(record).toMatchObject({ depth: 'count', isExactWordingCandidate: true });
		expect(thread.arrival).toMatchObject({ placement: 'today' });
	});
});

describe('#1384: explicit choices still win', () => {
	it('a message-scope digest Fix keeps it counted in the digest', async () => {
		const t = setup();
		const { source, messageId } = await arrive(t, PAYMENT, 'person', { threadOverride: 'digest' });
		await run(t, source);
		expect(llm.runLlmObject).not.toHaveBeenCalled();
		const { record, thread } = await snapshot(t, messageId);
		expect(record).toMatchObject({ depth: 'count', isExactWordingCandidate: true });
		expect(thread.arrival).toMatchObject({ placement: 'digest' });
	});

	it('an auto-archived or unsubscribed sender stays archived, unread', async () => {
		for (const senderStatus of ['auto_archive', 'unsubscribed'] as const) {
			const t = setup();
			const { source, messageId } = await arrive(t, LEGAL, 'person', { senderStatus });
			await run(t, source);
			expect(llm.runLlmObject).not.toHaveBeenCalled();
			const { record, thread } = await snapshot(t, messageId);
			expect(record).toMatchObject({ depth: 'none' });
			expect(thread.arrival).toMatchObject({ placement: 'archived' });
		}
	});
});
