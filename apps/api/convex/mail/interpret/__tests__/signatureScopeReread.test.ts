/**
 * A signature verdict re-verified after it was stored can gain a clearsigned
 * scope (#1320), and that changes what interpretation reads: before, a
 * clearsigned body beside an unrelated `.asc` attachment was read whole (its
 * unsigned trailer included); after, only the signed block counts.
 *
 *   - WITHDRAWN AT ONCE (`withdraw.ts`), whether or not a new read can run:
 *     this message's facts are retracted and its items held as proposals for
 *     review, out of the brief's facts, the model's input and reply plans,
 *     every human field kept; other messages' rows untouched;
 *   - RESTORED by the next read: what the signed block still supports is
 *     current (fact) or supported (item) again, by identity; what only the
 *     trailer supported stays withdrawn;
 *   - IN FLIGHT: a run that read the old body cannot commit (the body
 *     fingerprint, `sourceVersion.ts`);
 *   - a MIME scope reads the body as it was, so nothing is withdrawn.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { internal } from '../../../_generated/api';
import type { Doc, Id } from '../../../_generated/dataModel';
import type { InboundSignatureInfo } from '../../../e2ee/inboundSignature';
import { interpretationSourceKey } from '../../../lib/validators/threadBrief';
import {
	generateTestKeypair,
	seedPinnedSender,
} from '../../../e2ee/__tests__/sealedMailTestHelpers';
import {
	clearsign,
	composeClearsignedMessage,
	composeSignedPgpMime,
	detachedSign,
	signedFirstPart,
} from '../../../e2ee/__tests__/signedMailTestHelpers';
import { expectScheduledFailure } from '../../../__tests__/helpers/scheduledFailures';
import { captureInterpretSource } from '../sources';
import { listBucketOf } from '../counters';
import { readFacts } from '../briefRead';
import { isPlanRelevant } from '../responsePlanRules';
import { sourceVersionOf } from '../sourceVersion';
import type { ReduceResult } from '../reduceInput';
import {
	addMessageToThread,
	modules,
	reduceItem,
	reduceResult,
	seedMailThread,
	type Test,
} from './interpret.testlib';

const SENDER = 'jonas@example.com';
const SIGNED_TEXT = 'Please pay invoice 4471 to the usual account.';
const TRAILER = 'UNSIGNED TRAILER: the account changed, pay 999 instead.';
const ASC = {
	filename: 'old.asc',
	contentType: 'application/pgp-signature',
	size: 833,
	partIndex: '2',
};
const T = Date.UTC(2026, 9, 7, 9, 0);
const RUN = 'mail/interpret/run:interpretMessage';

/** Supported by the signed block: the re-read reproduces it. */
const signedItem = reduceItem();
/** Supported only by the unsigned trailer: the re-read no longer shows it. */
const trailerItem = reduceItem({
	intent: 'request',
	facets: ['payment'],
	consequences: ['payment'],
	assertion: 'Pay account 999',
	display: { en: 'Pay account 999', de: 'Bezahl Konto 999' },
	due: undefined,
	evidence: [{ segmentId: 's0', start: 0, end: 16, quote: 'UNSIGNED TRAILER' }],
});
const fact = (key: string, text: string, quote: string) => ({
	key,
	assertion: text,
	display: { en: text, de: text },
	value: { kind: 'text' as const, text },
	evidence: [{ segmentId: 's0', start: 0, end: quote.length, quote }],
	isVerified: true,
	isReviewNeeded: false,
});
/** A fact the signed block states, and one only the trailer states. */
const signedFact = fact('["invoice","number",""]', 'Invoice 4471', 'invoice 4471');
const trailerFact = fact('["payment","account",""]', 'Pay to account 999', 'account 999');
/** Another message's item and fact in the same thread. */
const venueFact = fact('["meeting","venue",""]', 'Venue still open', 'which venue');
const venueItem = reduceItem({
	intent: 'question',
	facets: ['meeting'],
	consequences: [],
	assertion: 'Confirm the venue',
	display: { en: 'Confirm the venue', de: 'Bestätig den Ort' },
	due: undefined,
	evidence: [{ segmentId: 's0', start: 0, end: 12, quote: 'which venue?' }],
});

/** Everything a person can set on an item: completion, a confirmation, a reminder. */
const HUMAN = {
	status: 'done',
	completion: 'asserted',
	correction: { by: 'user-A', at: T + 1, kind: 'confirmed' },
	remindAt: T + 86_400_000,
	confirmedFrom: {
		kind: 'proposal',
		confirmation: { by: 'user-A', at: T + 1, kind: 'confirmed' },
		verify: 'passed',
		addedEvidenceKeys: [],
	},
} as const;

beforeEach(() => {
	vi.stubEnv('INSTANCE_SECRET', 'unit-test-instance-secret-value');
});
afterEach(() => {
	vi.unstubAllEnvs();
});

/**
 * An interpreted Postbox message as an older release left it: a clearsigned
 * text body with an unsigned trailer, an unrelated `.asc` attachment (so the
 * old read took the whole body), an unscoped verified verdict, and the raw
 * message the verifier reads.
 */
async function seedLegacy(t: Test, opts: { mime?: boolean } = {}) {
	const { mailboxId, messageId, threadId } = await seedMailThread(t);
	const sender = await generateTestKeypair(SENDER);
	await seedPinnedSender(t, {
		address: SENDER,
		domain: 'example.com',
		pinnedPublicKeyArmored: sender.publicKeyArmored,
	});
	const armor = await clearsign(SIGNED_TEXT, sender.privateKeyArmored);
	let raw: string;
	if (opts.mime) {
		const part = signedFirstPart(SIGNED_TEXT);
		raw = composeSignedPgpMime({
			from: SENDER,
			to: 'me@owlat.test',
			subject: 'Invoice',
			part,
			signatureArmored: await detachedSign(part, sender.privateKeyArmored),
			messageId: '<reread-mime@example.com>',
		});
	} else {
		raw = composeClearsignedMessage({
			from: SENDER,
			to: 'me@owlat.test',
			subject: 'Invoice',
			clearsignArmor: armor,
			messageId: '<reread-clear@example.com>',
		});
	}
	const legacy: InboundSignatureInfo = {
		isSigned: true,
		isSignatureValid: true,
		signerFingerprint: sender.fingerprint,
		keySource: 'pinned',
	};
	await t.run(async (ctx) => {
		const rawStorageId = await ctx.storage.store(new Blob([Buffer.from(raw, 'latin1')]));
		await ctx.db.patch(messageId, {
			rawStorageId,
			textBodyInline: opts.mime ? SIGNED_TEXT : `${armor.trim()}\n\n${TRAILER}`,
			attachments: opts.mime ? [] : [ASC],
			hasAttachments: !opts.mime,
			inboundSignatureInfo: legacy,
		});
		await captureInterpretSource(ctx, { source: { kind: 'mail', id: messageId }, isLive: true });
	});
	// The enqueue snapshot marks it outstanding; the cached read below records it.
	return { mailboxId, messageId, threadId };
}

async function interpret(
	t: Test,
	messageId: Id<'mailMessages'>,
	threadId: Id<'mailThreads'>,
	opts: { contentRevision: string; result: ReduceResult; sourceVersion?: string }
) {
	const now = await stateOf(t, messageId, threadId);
	return t.mutation(internal.mail.interpret.reduce.applyInterpretation, {
		source: { kind: 'mail', id: messageId },
		threadRef: { kind: 'mail', id: threadId },
		mode: 'brief',
		contentRevision: opts.contentRevision,
		extractorVersion: 2,
		sourceAt: T,
		direction: 'inbound',
		status: 'complete',
		result: opts.result,
		sourceVersion: opts.sourceVersion ?? now.version!,
		deletionEpoch: now.epoch,
		expectedRevision: now.revision,
	});
}

async function stateOf(t: Test, messageId: Id<'mailMessages'>, threadId: Id<'mailThreads'>) {
	return t.run(async (ctx) => {
		const sourceKey = interpretationSourceKey({ kind: 'mail', id: messageId });
		const brief = await ctx.db
			.query('threadBriefs')
			.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
			.first();
		return {
			version: await sourceVersionOf(ctx, { kind: 'mail', id: messageId }),
			epoch: brief?.deletionEpoch ?? 0,
			revision: brief?.interpretationRevision ?? 0,
			verdict: (await ctx.db.get(messageId))!.inboundSignatureInfo,
			extractions: await ctx.db
				.query('messageInterpretations')
				.withIndex('by_source_revision', (q) => q.eq('sourceKey', sourceKey))
				.collect(),
			items: await ctx.db
				.query('threadItems')
				.withIndex('by_mail_thread_and_status', (q) => q.eq('mailThreadId', threadId))
				.collect(),
			snapshot: await ctx.db
				.query('interpretSources')
				.withIndex('by_source_key', (q) => q.eq('sourceKey', sourceKey))
				.first(),
			facts: await ctx.db
				.query('threadFacts')
				.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
				.collect(),
			briefFacts: (await readFacts(ctx, threadId, 'en')).map((f) => f.id),
			queued: (await ctx.db.system.query('_scheduled_functions').collect()).filter(
				(job) => job.name === RUN && job.state.kind === 'pending'
			),
		};
	});
}

/** The item a fold made from `claim` (matched by its facets, which differ per claim here). */
function itemOf(items: Doc<'threadItems'>[], claim: { facets: readonly string[] }) {
	return items.find((i) => i.facets.join() === claim.facets.join());
}

describe('a re-verified clearsigned scope re-reads the interpretation (#1320)', () => {
	/** The thread after the old read: this message's item and fact from each part, another message's too. */
	async function seedInterpreted(t: Test) {
		const { mailboxId, messageId, threadId } = await seedLegacy(t);
		const otherId = await addMessageToThread(
			t,
			{ mailboxId, threadId },
			{ text: 'Which venue do we use?', receivedAt: T - 3_600_000 }
		);
		await interpret(t, otherId, threadId, {
			contentRevision: 'rev-venue',
			result: reduceResult({ items: [venueItem], facts: [venueFact] }),
		});
		// The old read took the trailer: an item and a fact from each part.
		await interpret(t, messageId, threadId, {
			contentRevision: 'rev-old-read',
			result: reduceResult({ items: [signedItem, trailerItem], facts: [signedFact, trailerFact] }),
		});
		const seeded = await stateOf(t, messageId, threadId);
		const ids = {
			signed: itemOf(seeded.items, signedItem)!._id,
			trailer: itemOf(seeded.items, trailerItem)!._id,
			venue: itemOf(seeded.items, venueItem)!._id,
		};
		// Each fact is the one quoting its own span of its own message.
		const factOf = (id: Id<'mailMessages'>, quote: string) =>
			seeded.facts.find((f) =>
				f.evidence.some((e) => e.source.id === id && e.end === quote.length)
			)!;
		const facts = {
			signed: factOf(messageId, 'invoice 4471')._id,
			trailer: factOf(messageId, 'account 999')._id,
			venue: factOf(otherId, 'which venue')._id,
		};
		await t.run(async (ctx) => {
			for (const id of [ids.signed, ids.trailer, ids.venue]) {
				// The list projection follows the status, as the write path keeps it.
				const item = (await ctx.db.get(id))!;
				await ctx.db.patch(id, { ...HUMAN, listBucket: listBucketOf({ ...item, ...HUMAN }) });
			}
		});
		const other = await t.run(async (ctx) => ({
			item: await ctx.db.get(ids.venue),
			fact: await ctx.db.get(facts.venue),
		}));
		return { messageId, threadId, ids, facts, other, seeded };
	}

	/** What every machine consumer sees of the thread now. */
	async function consumersOf(t: Test, messageId: Id<'mailMessages'>, threadId: Id<'mailThreads'>) {
		const state = await stateOf(t, messageId, threadId);
		const input = await t.query(internal.mail.interpret.load.loadForInterpretation, {
			source: { kind: 'mail', id: messageId },
		});
		return {
			state,
			promptItems: input!.openItems.map((i) => i.id as string),
			promptFacts: input!.currentFacts.map((f) => f.id as string),
			planItems: state.items.filter((i) => isPlanRelevant(i)).map((i) => i._id as string),
		};
	}

	it('withdraws the old read at once, and a signed-only re-read restores what the block supports', async () => {
		// The queued run needs the LLM provider, which this module map leaves out.
		expectScheduledFailure(RUN);
		const t = convexTest(schema, modules);
		const { messageId, threadId, ids, facts, other, seeded } = await seedInterpreted(t);

		await t.action(internal.mail.mailbox.signatureReverify.run, { messageId });

		// (b) At once, before any new read: nothing of this message reaches a machine consumer.
		const now = await consumersOf(t, messageId, threadId);
		expect(now.state.verdict).toMatchObject({ isSignatureValid: true, scope: 'clearsigned' });
		for (const id of [ids.signed, ids.trailer]) {
			const item = now.state.items.find((i) => i._id === id)!;
			expect(item).toMatchObject({
				...HUMAN,
				verify: 'proposal',
				withdrawnFrom: { verify: 'passed' },
			});
			expect(now.promptItems).not.toContain(id);
			expect(now.planItems).not.toContain(id);
		}
		for (const id of [facts.signed, facts.trailer]) {
			expect(now.state.facts.find((f) => f._id === id)).toMatchObject({ status: 'retracted' });
			expect(now.state.briefFacts).not.toContain(id);
			expect(now.promptFacts).not.toContain(id);
		}
		// (d) another message's item and fact are untouched, and still reach the model.
		expect(await t.run((ctx) => ctx.db.get(ids.venue))).toEqual(other.item);
		expect(await t.run((ctx) => ctx.db.get(facts.venue))).toEqual(other.fact);
		expect(now.promptFacts).toContain(facts.venue);
		expect(now.state.queued).toHaveLength(1);
		expect(now.state.version).not.toBe(seeded.version);

		// The queued run lands: the signed block shows the signed claim and fact only.
		expect(
			await interpret(t, messageId, threadId, {
				contentRevision: 'rev-signed-block',
				result: reduceResult({ items: [signedItem], facts: [signedFact] }),
			})
		).toMatchObject({ outcome: 'applied' });

		const after = await consumersOf(t, messageId, threadId);
		// (c) the signed-block item and fact stand again, by identity, human state kept.
		const signed = after.state.items.find((i) => i._id === ids.signed)!;
		expect(signed).toMatchObject({ ...HUMAN, verify: 'passed' });
		expect(signed.withdrawnFrom).toBeUndefined();
		expect(after.state.facts.find((f) => f._id === facts.signed)).toMatchObject({
			status: 'current',
		});
		expect(after.state.briefFacts).toContain(facts.signed);
		expect(after.promptFacts).toContain(facts.signed);
		// (a) the trailer-only fact stays out of the brief and the model's input; its
		// item stays out of plans, held for review with every human field.
		expect(after.state.facts.find((f) => f._id === facts.trailer)).toMatchObject({
			status: 'retracted',
		});
		expect(after.state.briefFacts).not.toContain(facts.trailer);
		expect(after.promptFacts).not.toContain(facts.trailer);
		const trailer = after.state.items.find((i) => i._id === ids.trailer)!;
		expect(trailer).toMatchObject({
			...HUMAN,
			verify: 'proposal',
			withdrawnFrom: { verify: 'passed' },
		});
		expect(after.promptItems).not.toContain(ids.trailer);
		expect(after.planItems).not.toContain(ids.trailer);
		// (d) still untouched.
		expect(await t.run((ctx) => ctx.db.get(ids.venue))).toEqual(other.item);
		expect(await t.run((ctx) => ctx.db.get(facts.venue))).toEqual(other.fact);
	});

	it.each([
		['the ai flag is off', { errorCode: 'ai_off' }],
		[
			'the spend hold refuses',
			{ errorCode: 'budget', budgetRefusal: { reason: 'monthly_ceiling', limit: 'interpret' } },
		],
	] as const)('keeps the old read withdrawn when %s', async (_case, refusal) => {
		expectScheduledFailure(RUN);
		const t = convexTest(schema, modules);
		const { messageId, threadId, ids, facts } = await seedInterpreted(t);
		await t.action(internal.mail.mailbox.signatureReverify.run, { messageId });

		// The queued run is refused before any model call: it records the refusal and nothing else.
		const loaded = await stateOf(t, messageId, threadId);
		expect(
			await t.mutation(internal.mail.interpret.reduce.applyInterpretation, {
				source: { kind: 'mail', id: messageId },
				threadRef: { kind: 'mail', id: threadId },
				mode: 'brief',
				contentRevision: 'rev-signed-block',
				extractorVersion: 2,
				sourceAt: T,
				direction: 'inbound',
				status: 'failed',
				...refusal,
				sourceVersion: loaded.version!,
				deletionEpoch: loaded.epoch,
				expectedRevision: loaded.revision,
			})
		).toMatchObject({ outcome: 'applied' });

		const now = await consumersOf(t, messageId, threadId);
		for (const id of [ids.signed, ids.trailer]) {
			expect(now.state.items.find((i) => i._id === id)).toMatchObject({
				...HUMAN,
				verify: 'proposal',
			});
			expect(now.promptItems).not.toContain(id);
			expect(now.planItems).not.toContain(id);
		}
		for (const id of [facts.signed, facts.trailer]) {
			expect(now.state.briefFacts).not.toContain(id);
			expect(now.promptFacts).not.toContain(id);
		}
	});

	it('refuses a first run that read the old body, which starts over on the new read', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedLegacy(t);
		const loaded = await stateOf(t, messageId, threadId);

		await t.action(internal.mail.mailbox.signatureReverify.run, { messageId });

		const now = await stateOf(t, messageId, threadId);
		expect(now.verdict).toMatchObject({ scope: 'clearsigned' });
		expect(now.version).not.toBe(loaded.version);
		// Never interpreted: nothing cached to read again, the run under way restarts.
		expect(now.queued).toHaveLength(0);
		expect(
			await interpret(t, messageId, threadId, {
				contentRevision: 'rev-old-read',
				result: reduceResult({ items: [trailerItem] }),
				sourceVersion: loaded.version!,
			})
		).toEqual({ outcome: 'sourceChanged' });
		expect((await stateOf(t, messageId, threadId)).items).toHaveLength(0);
	});

	it('refuses a retry of the cached read in flight across the re-verify', async () => {
		expectScheduledFailure(RUN);
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedLegacy(t);
		await interpret(t, messageId, threadId, {
			contentRevision: 'rev-old-read',
			result: reduceResult({ items: [signedItem] }),
		});
		// A retry of the old read loads here ...
		const loaded = await stateOf(t, messageId, threadId);

		await t.action(internal.mail.mailbox.signatureReverify.run, { messageId });

		// ... and lands after the scope changed: nothing of it is written.
		expect(
			await interpret(t, messageId, threadId, {
				contentRevision: 'rev-old-read-retry',
				result: reduceResult({ items: [signedItem, trailerItem] }),
				sourceVersion: loaded.version!,
			})
		).toEqual({ outcome: 'sourceChanged' });
		const after = await stateOf(t, messageId, threadId);
		expect(after.items).toHaveLength(1);
		expect(itemOf(after.items, trailerItem)).toBeUndefined();
	});

	it('leaves the interpretation alone when the new scope reads the body as it was (MIME)', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedLegacy(t, { mime: true });
		await interpret(t, messageId, threadId, {
			contentRevision: 'rev-old-read',
			result: reduceResult({ items: [signedItem] }),
		});
		const before = await stateOf(t, messageId, threadId);

		await t.action(internal.mail.mailbox.signatureReverify.run, { messageId });

		const after = await stateOf(t, messageId, threadId);
		expect(after.verdict).toMatchObject({ isSignatureValid: true, scope: 'mime' });
		expect(after.version).toBe(before.version);
		expect(after.extractions).toHaveLength(1);
		expect(after.queued).toHaveLength(0);
	});
});
