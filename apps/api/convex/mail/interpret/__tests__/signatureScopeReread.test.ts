/**
 * A signature verdict re-verified after it was stored can gain a clearsigned
 * scope (#1320), and that changes what interpretation reads: before, a
 * clearsigned body beside an unrelated `.asc` attachment was read whole (its
 * unsigned trailer and HTML included); after, only the signed block counts.
 *
 *   - CACHED: what the old read contributed to the brief goes (extraction,
 *     its claims), the enqueue snapshot stays, and the message is queued to be
 *     interpreted again through the normal run (gate, spend hold, model);
 *   - IN FLIGHT: a run that read the old body cannot commit, by the body
 *     fingerprint (`sourceVersion.ts`) as well as by the purge epoch;
 *   - a MIME scope reads the body as it was, so nothing is re-read.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { internal } from '../../../_generated/api';
import type { Id } from '../../../_generated/dataModel';
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
import { sourceVersionOf } from '../sourceVersion';
import { modules, reduceItem, reduceResult, seedMailThread, type Test } from './interpret.testlib';

const SENDER = 'jonas@example.com';
const SIGNED_TEXT = 'Please pay invoice 4471 to the usual account.';
const TRAILER = 'UNSIGNED TRAILER: the account changed, pay 999 instead.';
const ASC = {
	filename: 'old.asc',
	contentType: 'application/pgp-signature',
	size: 833,
	partIndex: '2',
};

const trailerItem = reduceItem({
	intent: 'request',
	facets: ['payment'],
	consequences: ['payment'],
	assertion: 'Pay account 999',
	display: { en: 'Pay account 999', de: 'Bezahl Konto 999' },
	due: undefined,
	evidence: [{ segmentId: 's0', start: 0, end: 16, quote: 'UNSIGNED TRAILER' }],
});

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
	const { messageId, threadId } = await seedMailThread(t);
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
	return { messageId, threadId };
}

async function interpret(
	t: Test,
	messageId: Id<'mailMessages'>,
	threadId: Id<'mailThreads'>,
	at: { sourceVersion: string; deletionEpoch: number; expectedRevision: number }
) {
	return t.mutation(internal.mail.interpret.reduce.applyInterpretation, {
		source: { kind: 'mail', id: messageId },
		threadRef: { kind: 'mail', id: threadId },
		mode: 'brief',
		contentRevision: 'rev-old-read',
		extractorVersion: 2,
		sourceAt: Date.UTC(2026, 9, 7, 9, 0),
		direction: 'inbound',
		status: 'complete',
		result: reduceResult({ items: [trailerItem] }),
		...at,
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
				(job) => job.name === 'mail/interpret/run:interpretMessage' && job.state.kind === 'pending'
			),
		};
	});
}

describe('a re-verified clearsigned scope re-reads the interpretation (#1320)', () => {
	it('drops the cached read of the unsigned trailer and queues the message again', async () => {
		// The queued run needs the LLM provider, which this module map leaves out.
		expectScheduledFailure('mail/interpret/run:interpretMessage');
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedLegacy(t);
		const before = await stateOf(t, messageId, threadId);
		expect(
			await interpret(t, messageId, threadId, {
				sourceVersion: before.version!,
				deletionEpoch: before.epoch,
				expectedRevision: before.revision,
			})
		).toMatchObject({ outcome: 'applied' });
		expect((await stateOf(t, messageId, threadId)).items).toHaveLength(1);

		await t.action(internal.mail.mailbox.signatureReverify.run, { messageId });

		const after = await stateOf(t, messageId, threadId);
		expect(after.verdict).toMatchObject({ isSignatureValid: true, scope: 'clearsigned' });
		// What the old read contributed is gone ...
		expect(after.extractions).toHaveLength(0);
		expect(after.items).toHaveLength(0);
		// ... the eligibility snapshot stays, with no claims of its own ...
		expect(after.snapshot).not.toBeNull();
		expect(after.snapshot!.claimIds ?? []).toHaveLength(0);
		expect(after.snapshot!.isOutstanding).toBe(true);
		// ... and the message is interpreted again, through the normal run.
		expect(after.queued.map((job) => job.args[0])).toEqual([
			{ source: { kind: 'mail', id: messageId } },
		]);
	});

	it('refuses a run that read the old body, by its fingerprint and by the epoch', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedLegacy(t);
		// Never interpreted yet: the run below is the first, still in flight.
		const loaded = await stateOf(t, messageId, threadId);

		await t.action(internal.mail.mailbox.signatureReverify.run, { messageId });

		const now = await stateOf(t, messageId, threadId);
		expect(now.verdict).toMatchObject({ scope: 'clearsigned' });
		expect(now.version).not.toBe(loaded.version);
		expect(
			await interpret(t, messageId, threadId, {
				sourceVersion: loaded.version!,
				deletionEpoch: now.epoch,
				expectedRevision: now.revision,
			})
		).toEqual({ outcome: 'sourceChanged' });
		expect((await stateOf(t, messageId, threadId)).items).toHaveLength(0);
	});

	it('refuses a cached run in flight across the re-read', async () => {
		expectScheduledFailure('mail/interpret/run:interpretMessage');
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedLegacy(t);
		const first = await stateOf(t, messageId, threadId);
		await interpret(t, messageId, threadId, {
			sourceVersion: first.version!,
			deletionEpoch: first.epoch,
			expectedRevision: first.revision,
		});
		// A retry of the old read loads here ...
		const loaded = await stateOf(t, messageId, threadId);

		await t.action(internal.mail.mailbox.signatureReverify.run, { messageId });

		// ... and lands after the re-read started: erased, nothing written back.
		expect(
			await interpret(t, messageId, threadId, {
				sourceVersion: loaded.version!,
				deletionEpoch: loaded.epoch,
				expectedRevision: (await stateOf(t, messageId, threadId)).revision,
			})
		).toEqual({ outcome: 'erased' });
		const after = await stateOf(t, messageId, threadId);
		expect(after.extractions).toHaveLength(0);
		expect(after.items).toHaveLength(0);
	});

	it('leaves the interpretation alone when the new scope reads the body as it was (MIME)', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedLegacy(t, { mime: true });
		const before = await stateOf(t, messageId, threadId);
		await interpret(t, messageId, threadId, {
			sourceVersion: before.version!,
			deletionEpoch: before.epoch,
			expectedRevision: before.revision,
		});

		await t.action(internal.mail.mailbox.signatureReverify.run, { messageId });

		const after = await stateOf(t, messageId, threadId);
		expect(after.verdict).toMatchObject({ isSignatureValid: true, scope: 'mime' });
		expect(after.version).toBe(before.version);
		expect(after.epoch).toBe(before.epoch);
		expect(after.extractions).toHaveLength(1);
		expect(after.queued).toHaveLength(0);
	});
});
