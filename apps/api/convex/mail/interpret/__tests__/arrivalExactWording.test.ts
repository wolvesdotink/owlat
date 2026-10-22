/**
 * Read on arrival, #1384: payment and legal mail is never buried in the
 * digest or updates. An exact-wording candidate (changed bank details, a
 * legal notice, an invoice with payment details) is read in full when the
 * budget and the owner limit allow, and placed in Today either way, whatever
 * the sender's digest status, a rule, a sender override or the category say.
 * The person's explicit choices still win: a message-scope Fix made after it
 * arrived (an older one does not bury it), an auto-archived sender. The
 * screen is written only for the body and deletion epoch it was taken from. A candidate read the text-blind admission let through
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
import { attachThreadState } from '../../mailbox/rowThreadState';
import { freshTextOf } from '../../arrival/scopedInput';
import { scopeForInterpretation, segmentScoped } from '../scope';
import { sourceVersionOf } from '../sourceVersion';
import { loadBriefRow } from '../briefRow';

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
		getMutationContext: vi.fn(async () => session),
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
	/** When the thread override was set: after the message arrived (default) or before. */
	threadOverrideSet?: 'before' | 'after';
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
		const record = await writeArrivalRecord(ctx, (await ctx.db.get(seeded.messageId))!, {
			isLive: true,
			...(burial.rulePlacement ? { rulePlacement: burial.rulePlacement } : {}),
		});
		if (burial.threadOverride) {
			// A Fix of this conversation, made before or after this message arrived.
			const setAt = record!.createdAt + (burial.threadOverrideSet === 'before' ? -60_000 : 0);
			await ctx.db.patch(seeded.threadId, {
				placementOverride: {
					placement: burial.threadOverride,
					setAt,
					operationId: await ctx.db.insert('mailArrivalOperations', {
						mailboxId: seeded.mailboxId,
						kind: 'fix',
						actor: 'user',
						changeCount: 0,
						status: 'applied',
						createdAt: setAt,
						expiresAt: setAt + 1,
					}),
				},
			});
		}
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
	// A Fix of the conversation made before this message arrived (Sol r1 F1).
	[
		'an older thread Fix to the digest',
		'person',
		{ threadOverride: 'digest', threadOverrideSet: 'before' },
	],
	[
		'an older thread Fix to updates',
		'notification',
		{ threadOverride: 'updates', threadOverrideSet: 'before' },
	],
];

describe('#1384: the text really is a candidate', () => {
	it.each(CANDIDATES)('%s', (_name, text) => {
		expect(detectExactWording({ subject: 'hello', text }).length).toBeGreaterThan(0);
	});
});

describe('#1384: an exact-wording candidate is read in full and placed in Today', () => {
	it.each(
		CANDIDATES.flatMap(([what, text]) =>
			BURIALS.map(([name, category, burial]) => [what, name, text, category, burial] as const)
		)
	)('%s despite %s', async (_what, _name, text, category, burial) => {
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

describe('#1384: an older thread Fix does not bury it in any view', () => {
	it('Why here? and the list row both say Today', async () => {
		const t = setup();
		const { source, threadId, messageId } = await arrive(t, PAYMENT, 'person', {
			threadOverride: 'digest',
			threadOverrideSet: 'before',
		});
		await run(t, source);
		const why = await t.query(api.mail.arrival.explain.forThread, { threadId });
		expect(why).toMatchObject({ placement: 'today', decidedBy: 'exact_wording', depth: 'full' });
		expect(why?.override).toBeUndefined();
		const [row] = await t.run(async (ctx) =>
			attachThreadState(ctx, [(await ctx.db.get(messageId))!])
		);
		expect(row?.placement).toBe('today');
	});

	it('the same older Fix still files a message without the wording', async () => {
		const t = setup();
		const { source, messageId } = await arrive(t, NOTICE, 'person', {
			threadOverride: 'digest',
			threadOverrideSet: 'before',
		});
		await run(t, source);
		expect(llm.runLlmObject).not.toHaveBeenCalled();
		const { record, thread } = await snapshot(t, messageId);
		expect(record).toMatchObject({ depth: 'count' });
		expect(thread.arrival).toMatchObject({ placement: 'digest' });
	});
});

describe('#1384: a screen is written only for the current source (Sol r1 F2)', () => {
	/** A clearsigned notice with an unsigned payment trailer, verified before verdict scopes. */
	async function signedWithTrailer(t: Test) {
		const body = [
			'-----BEGIN PGP SIGNED MESSAGE-----',
			'Hash: SHA256',
			'',
			NOTICE,
			'-----BEGIN PGP SIGNATURE-----',
			'placeholder',
			'-----END PGP SIGNATURE-----',
			'',
			PAYMENT,
		].join('\n');
		const arrived = await arrive(t, body, 'notification');
		await t.run((ctx) =>
			ctx.db.patch(arrived.messageId, {
				attachments: [
					{
						filename: 'old.asc',
						contentType: 'application/pgp-signature',
						size: 20,
						partIndex: '2',
					},
				],
				inboundSignatureInfo: { isSigned: true, isSignatureValid: true, keySource: 'pinned' },
			})
		);
		const before = await t.run((ctx) => sourceVersionOf(ctx, arrived.source));
		const scoped = await t.action((ctx) => scopeForInterpretation(ctx, arrived.source));
		if (!scoped?.ok) throw new Error('scope unavailable');
		const fresh = freshTextOf(segmentScoped(scoped).segmented);
		// The unsigned trailer is read before the re-verify...
		expect(detectExactWording({ subject: scoped.subject, text: fresh }).length).toBeGreaterThan(0);
		await t.mutation(internal.mail.mailbox.signatureReverify.apply, {
			messageId: arrived.messageId,
			info: {
				isSigned: true,
				isSignatureValid: true,
				keySource: 'pinned',
				scope: 'clearsigned',
			},
			isReadChanged: true,
		});
		// ...and the clearsigned scope drops it.
		const now = await t.action((ctx) => scopeForInterpretation(ctx, arrived.source));
		if (!now?.ok) throw new Error('scope unavailable');
		expect(
			detectExactWording({ subject: now.subject, text: freshTextOf(segmentScoped(now).segmented) })
		).toEqual([]);
		expect(now.sourceVersion).not.toBe(before);
		return { ...arrived, oldVersion: before! };
	}

	it('the depth decision refuses the screen of the old scope and restarts the run', async () => {
		const t = setup();
		const { source, messageId, oldVersion } = await signedWithTrailer(t);
		const claim = await t.mutation(internal.mail.interpret.lease.claimSourceLease, { source });
		if (claim.kind !== 'claimed') throw new Error('lease not claimed');
		const verdict = await t.mutation(internal.mail.interpret.arrivalDecide.decideArrivalDepth, {
			source,
			leaseToken: claim.token,
			deletionEpoch: 0,
			sourceVersion: oldVersion,
			isSecurityMail: false,
			isExactWordingCandidate: true,
		});
		expect(verdict).toEqual({ kind: 'sourceChanged' });
		const { record, thread } = await snapshot(t, messageId);
		expect(record?.isExactWordingCandidate).toBeUndefined();
		expect(thread.arrival?.placement).toBe('updates');
	});

	it('the counted screen refuses the old scope and takes the current one', async () => {
		const t = setup();
		const { source, messageId, oldVersion } = await signedWithTrailer(t);
		const note = (sourceVersion: string, isExactWordingCandidate: boolean) =>
			t.mutation(internal.mail.interpret.arrivalDecide.noteCountedArrivalScreen, {
				source,
				isExactWordingCandidate,
				deletionEpoch: 0,
				sourceVersion,
			});
		expect(await note(oldVersion, true)).toBe('sourceChanged');
		expect((await snapshot(t, messageId)).record?.isExactWordingCandidate).toBeUndefined();
		const current = (await t.run((ctx) => sourceVersionOf(ctx, source)))!;
		expect(await note(current, false)).toBe('noted');
		expect((await snapshot(t, messageId)).thread.arrival?.placement).toBe('updates');
	});

	it('a stale deletion epoch writes no screen and keeps the placement', async () => {
		const t = setup();
		const { source, messageId, threadId } = await arrive(t, PAYMENT, 'newsletter');
		const claim = await t.mutation(internal.mail.interpret.lease.claimSourceLease, { source });
		if (claim.kind !== 'claimed') throw new Error('lease not claimed');
		const epoch = await t.run(
			async (ctx) => (await loadBriefRow(ctx, { kind: 'mail', id: threadId }))?.deletionEpoch ?? 0
		);
		expect((await snapshot(t, messageId)).thread.arrival?.placement).toBe('digest');
		const current = (await t.run((ctx) => sourceVersionOf(ctx, source)))!;
		const verdict = await t.mutation(internal.mail.interpret.arrivalDecide.decideArrivalDepth, {
			source,
			leaseToken: claim.token,
			deletionEpoch: epoch + 1,
			sourceVersion: current,
			isSecurityMail: false,
			isExactWordingCandidate: true,
		});
		expect(verdict).toEqual({ kind: 'gone' });
		expect(
			await t.mutation(internal.mail.interpret.arrivalDecide.noteCountedArrivalScreen, {
				source,
				isExactWordingCandidate: true,
				deletionEpoch: epoch + 1,
				sourceVersion: current,
			})
		).toBe('gone');
		const { record, thread } = await snapshot(t, messageId);
		expect(record?.isExactWordingCandidate).toBeUndefined();
		expect(thread.arrival?.placement).toBe('digest');
	});
});

describe('#1384: explicit choices still win', () => {
	it('a digest Fix made after it arrived keeps it counted in the digest', async () => {
		const t = setup();
		const { source, messageId } = await arrive(t, PAYMENT, 'person', { threadOverride: 'digest' });
		await run(t, source);
		expect(llm.runLlmObject).not.toHaveBeenCalled();
		const { record, thread } = await snapshot(t, messageId);
		expect(record).toMatchObject({ depth: 'count', isExactWordingCandidate: true });
		expect(thread.arrival).toMatchObject({ placement: 'digest' });
	});

	// Sol r3b: the same destination chosen again renews the overruled Fix.
	it.each(['digest', 'updates'] as const)(
		'choosing %s again after an older Fix was overruled files it there, undoably',
		async (destination) => {
			const t = setup();
			const { source, messageId } = await arrive(t, PAYMENT, 'person', {
				threadOverride: destination,
				threadOverrideSet: 'before',
			});
			await run(t, source);
			const old = (await snapshot(t, messageId)).thread;
			expect(old.arrival).toMatchObject({ placement: 'today' });
			const fixed = await t.mutation(api.mail.arrival.fix.apply, {
				messageId,
				destination,
				scope: 'message',
			});
			expect(fixed.operationId).not.toBeNull();
			const { thread } = await snapshot(t, messageId);
			expect(thread.arrival).toMatchObject({ placement: destination });
			expect(thread.placementOverride?.operationId).toBe(fixed.operationId);
			expect(thread.placementOverride!.setAt).toBeGreaterThan(old.placementOverride!.setAt);
			// Choosing it once more changes nothing: the renewed Fix holds.
			const again = await t.mutation(api.mail.arrival.fix.apply, {
				messageId,
				destination,
				scope: 'message',
			});
			expect(again.operationId).toBeNull();
			// Undo restores the older, overruled Fix, and the wording places it again.
			await t.mutation(api.mail.arrival.operations.undo, { operationId: fixed.operationId! });
			const undone = (await snapshot(t, messageId)).thread;
			expect(undone.placementOverride).toEqual(old.placementOverride);
			expect(undone.arrival).toMatchObject({ placement: 'today' });
		}
	);

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
