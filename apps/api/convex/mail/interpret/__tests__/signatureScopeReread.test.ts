/**
 * A signature verdict re-verified after it was stored can gain a clearsigned
 * scope (#1320), and that changes what interpretation reads: before, a
 * clearsigned body beside an unrelated `.asc` attachment was read whole (its
 * unsigned trailer included); after, only the signed block counts.
 *
 *   - CACHED: nothing is erased. The message is queued to be read again
 *     (`enqueue.ts enqueueReread`); the re-read keeps every item it reproduces
 *     with each field a person set, flags an item only the unsigned trailer
 *     supported for review (human state kept), and leaves other messages'
 *     items alone;
 *   - IN FLIGHT: a run that read the old body cannot commit (the body
 *     fingerprint, `sourceVersion.ts`) and starts over on the new read;
 *   - a MIME scope reads the body as it was, so nothing is re-read.
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
/** Another message's item in the same thread. */
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
	it('keeps every item and what people set on them, and flags what the trailer alone supported', async () => {
		// The queued run needs the LLM provider, which this module map leaves out.
		expectScheduledFailure(RUN);
		const t = convexTest(schema, modules);
		const { mailboxId, messageId, threadId } = await seedLegacy(t);
		const otherId = await addMessageToThread(
			t,
			{ mailboxId, threadId },
			{ text: 'Which venue do we use?', receivedAt: T - 3_600_000 }
		);
		await interpret(t, otherId, threadId, {
			contentRevision: 'rev-venue',
			result: reduceResult({ items: [venueItem] }),
		});
		// The old read took the trailer: one item from the signed block, one from the trailer.
		await interpret(t, messageId, threadId, {
			contentRevision: 'rev-old-read',
			result: reduceResult({ items: [signedItem, trailerItem] }),
		});
		const seeded = await stateOf(t, messageId, threadId);
		const signedId = itemOf(seeded.items, signedItem)!._id;
		const trailerId = itemOf(seeded.items, trailerItem)!._id;
		const venueId = itemOf(seeded.items, venueItem)!._id;
		await t.run(async (ctx) => {
			for (const id of [signedId, trailerId, venueId]) {
				// The list projection follows the status, as the write path keeps it.
				const item = (await ctx.db.get(id))!;
				await ctx.db.patch(id, { ...HUMAN, listBucket: listBucketOf({ ...item, ...HUMAN }) });
			}
		});
		const venueBefore = await t.run((ctx) => ctx.db.get(venueId));

		await t.action(internal.mail.mailbox.signatureReverify.run, { messageId });

		// Nothing is erased; the message is queued to be read again, once.
		const queued = await stateOf(t, messageId, threadId);
		expect(queued.verdict).toMatchObject({ isSignatureValid: true, scope: 'clearsigned' });
		expect(queued.extractions).toHaveLength(1);
		expect(queued.items).toHaveLength(3);
		expect(queued.epoch).toBe(seeded.epoch);
		expect(queued.snapshot).toMatchObject({ isOutstanding: true });
		expect(queued.snapshot!.claimIds?.length).toBeGreaterThan(0);
		expect(queued.queued.map((job) => job.args[0])).toEqual([
			{ source: { kind: 'mail', id: messageId } },
		]);
		expect(queued.version).not.toBe(seeded.version);

		// The queued run lands: the signed block shows only the signed claim.
		expect(
			await interpret(t, messageId, threadId, {
				contentRevision: 'rev-signed-block',
				result: reduceResult({ items: [signedItem] }),
			})
		).toMatchObject({ outcome: 'applied' });

		const after = await stateOf(t, messageId, threadId);
		// (a) the signed-block claim keeps its identity, completion, confirmation and reminder.
		expect(after.items.find((i) => i._id === signedId)).toMatchObject(HUMAN);
		// (c) the trailer-only claim is flagged for review, never deleted; its human state stays.
		expect(after.items.find((i) => i._id === trailerId)).toMatchObject({
			...HUMAN,
			isReviewNeeded: true,
		});
		// (b) another message's item is not touched at all, its undo snapshot included.
		expect(await t.run((ctx) => ctx.db.get(venueId))).toEqual(venueBefore);
		expect(after.snapshot?.isOutstanding).not.toBe(true);
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
