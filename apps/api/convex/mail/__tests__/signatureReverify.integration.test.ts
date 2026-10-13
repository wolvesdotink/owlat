/**
 * Re-verifying a signed message stored before verdicts recorded a scope (#1320).
 *
 * Rows are seeded the way an older release left them: the raw `.eml` in
 * storage and an `inboundSignatureInfo` with no `scope`, which the reader
 * withholds. Re-verification runs the current verifier over the raw message and
 * must:
 *   - give a genuinely signed message its scoped verified verdict back;
 *   - never carry an old "verified" over to a tampered message, or to one the
 *     PGP/MIME structure cross-check refuses;
 *   - leave a row it cannot re-verify (raw message gone, nothing signed in it)
 *     exactly as it was, and never touch unsigned mail;
 *   - queue work only for a reader of the mailbox, once per message per window.
 */

import { convexTest, type TestConvex } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import type { InboundSignatureInfo } from '../../e2ee/inboundSignature';
import { generateTestKeypair, seedPinnedSender } from '../../e2ee/__tests__/sealedMailTestHelpers';
import {
	clearsign,
	composeClearsignedMessage,
	composeSignedPgpMime,
	detachedSign,
	signedFirstPart,
} from '../../e2ee/__tests__/signedMailTestHelpers';
import { modules, seedFolder, seedMailbox, seedMessage } from './helpers.testlib';

const sessionMocks = vi.hoisted(() => ({ userId: 'user-A', role: 'owner' as 'owner' | 'member' }));
vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	const session = () => ({
		userId: sessionMocks.userId,
		role: sessionMocks.role,
		activeOrganizationId: 'org-1',
	});
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session()),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => session()),
		getBetterAuthSessionWithRole: vi.fn(async () => session()),
	};
});

type T = TestConvex<typeof schema>;

const SENDER = 'alice@sender.test';
const BOUNDARY = 'owlat-f1-signed';
const CLOSE = `--${BOUNDARY}--`;

/** What a pre-#1316 release stored for a message that verified. */
const LEGACY_VERIFIED = (fingerprint: string): InboundSignatureInfo => ({
	isSigned: true,
	isSignatureValid: true,
	signerFingerprint: fingerprint,
	keySource: 'pinned',
});

beforeEach(() => {
	sessionMocks.userId = 'user-A';
	sessionMocks.role = 'owner';
	vi.stubEnv('INSTANCE_SECRET', 'unit-test-instance-secret-value');
});
afterEach(() => {
	vi.unstubAllEnvs();
});

async function setup() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	const mailboxId = await seedMailbox(t, { userId: 'user-A', address: 'me@example.com' });
	await seedFolder(t, mailboxId);
	const sender = await generateTestKeypair(SENDER);
	await seedPinnedSender(t, {
		address: SENDER,
		domain: 'sender.test',
		pinnedPublicKeyArmored: sender.publicKeyArmored,
	});
	return { t, mailboxId, sender };
}

async function signedMime(privateKeyArmored: string): Promise<string> {
	const part = signedFirstPart('Signed content.');
	return composeSignedPgpMime({
		from: SENDER,
		to: 'me@example.com',
		subject: 'signed',
		part,
		signatureArmored: await detachedSign(part, privateKeyArmored),
		messageId: '<reverify-1320@sender.test>',
		boundary: BOUNDARY,
	});
}

/** A message row holding `raw` as its stored original, with `info` as its verdict. */
async function seedStored(
	t: T,
	mailboxId: Id<'mailboxes'>,
	raw: string | null,
	info?: InboundSignatureInfo
): Promise<Id<'mailMessages'>> {
	const messageId = await seedMessage(t, mailboxId, { fromAddress: SENDER });
	await t.run(async (ctx) => {
		const row = await ctx.db.get(messageId);
		if (raw === null) await ctx.storage.delete(row!.rawStorageId);
		else {
			const rawStorageId = await ctx.storage.store(new Blob([Buffer.from(raw, 'latin1')]));
			await ctx.db.patch(messageId, { rawStorageId });
		}
		if (info) await ctx.db.patch(messageId, { inboundSignatureInfo: info });
	});
	return messageId;
}

async function reverify(t: T, messageId: Id<'mailMessages'>) {
	await t.action(internal.mail.mailbox.signatureReverify.run, { messageId });
	return await t.run(async (ctx) => (await ctx.db.get(messageId))!);
}

async function scheduledReverifies(t: T): Promise<number> {
	return await t.run(
		async (ctx) =>
			(await ctx.db.system.query('_scheduled_functions').collect()).filter((job) =>
				job.name.includes('signatureReverify')
			).length
	);
}

describe('re-verifying signed mail stored before verdict scopes (#1320)', () => {
	it('a pre-scope PGP/MIME message regains its verified verdict, now scoped', async () => {
		const { t, mailboxId, sender } = await setup();
		const raw = await signedMime(sender.privateKeyArmored);
		const messageId = await seedStored(t, mailboxId, raw, LEGACY_VERIFIED(sender.fingerprint));

		const row = await reverify(t, messageId);
		expect(row.inboundSignatureInfo).toEqual({
			...LEGACY_VERIFIED(sender.fingerprint),
			scope: 'mime',
		});

		// Settled: the row no longer needs re-verifying, so the reader stops asking.
		await t.mutation(api.mail.mailbox.signatureReverify.request, { messageId });
		expect(await scheduledReverifies(t)).toBe(0);
	});

	it('a pre-scope clearsigned message regains its verified verdict, now scoped', async () => {
		const { t, mailboxId, sender } = await setup();
		const raw = composeClearsignedMessage({
			from: SENDER,
			to: 'me@example.com',
			subject: 'clearsigned',
			clearsignArmor: await clearsign('Clear text.', sender.privateKeyArmored),
			messageId: '<reverify-1320-clear@sender.test>',
		});
		const messageId = await seedStored(t, mailboxId, raw, LEGACY_VERIFIED(sender.fingerprint));

		const row = await reverify(t, messageId);
		expect(row.inboundSignatureInfo).toEqual({
			...LEGACY_VERIFIED(sender.fingerprint),
			scope: 'clearsigned',
		});
	});

	it('a tampered message does not keep an old "verified": it gets the scoped invalid verdict', async () => {
		const { t, mailboxId, sender } = await setup();
		const raw = (await signedMime(sender.privateKeyArmored)).replace(
			'Signed content.',
			'Signed TAMPERED.'
		);
		const messageId = await seedStored(t, mailboxId, raw, LEGACY_VERIFIED(sender.fingerprint));

		const row = await reverify(t, messageId);
		expect(row.inboundSignatureInfo).toEqual({
			isSigned: true,
			isSignatureValid: false,
			keySource: 'pinned',
			scope: 'mime',
		});
	});

	it('a PGP/MIME message with a part after the signature fails the structure cross-check', async () => {
		const { t, mailboxId, sender } = await setup();
		// The signature still verifies over the first part; the reader would
		// also show the appended HTML, so nothing may be called verified.
		const raw = (await signedMime(sender.privateKeyArmored)).replace(
			`\r\n${CLOSE}`,
			`\n--${BOUNDARY}\r\nContent-Type: text/html\r\n\r\n<p>UNSIGNED</p>\r\n${CLOSE}`
		);
		const messageId = await seedStored(t, mailboxId, raw, LEGACY_VERIFIED(sender.fingerprint));

		const row = await reverify(t, messageId);
		expect(row.inboundSignatureInfo).toEqual({
			isSigned: true,
			isSignatureValid: false,
			keySource: 'pinned',
			failure: 'malformed_signature',
			scope: 'mime',
		});
	});

	it('a row whose raw message is gone keeps its withheld verdict', async () => {
		const { t, mailboxId, sender } = await setup();
		const legacy = LEGACY_VERIFIED(sender.fingerprint);
		const messageId = await seedStored(t, mailboxId, null, legacy);

		const row = await reverify(t, messageId);
		expect(row.inboundSignatureInfo).toEqual(legacy);
	});

	it('an unscoped verdict on a raw message the verifier finds no signature in is left alone', async () => {
		const { t, mailboxId, sender } = await setup();
		const legacy = LEGACY_VERIFIED(sender.fingerprint);
		const raw = 'From: alice@sender.test\r\nSubject: plain\r\n\r\nNothing signed here.\r\n';
		const messageId = await seedStored(t, mailboxId, raw, legacy);

		const row = await reverify(t, messageId);
		expect(row.inboundSignatureInfo).toEqual(legacy);
	});

	it('unsigned mail is never queued and never touched', async () => {
		const { t, mailboxId } = await setup();
		const raw = 'From: alice@sender.test\r\nSubject: plain\r\n\r\nHello.\r\n';
		const messageId = await seedStored(t, mailboxId, raw);

		await t.mutation(api.mail.mailbox.signatureReverify.request, { messageId });
		expect(await scheduledReverifies(t)).toBe(0);
		const row = await reverify(t, messageId);
		expect(row.inboundSignatureInfo).toBeUndefined();
	});

	it('only a reader of the mailbox can queue it, once per message per window', async () => {
		const { t, mailboxId, sender } = await setup();
		const raw = await signedMime(sender.privateKeyArmored);
		const messageId = await seedStored(t, mailboxId, raw, LEGACY_VERIFIED(sender.fingerprint));

		// Another member of the org: no access to someone else's personal mailbox.
		sessionMocks.userId = 'user-B';
		sessionMocks.role = 'member';
		await t.mutation(api.mail.mailbox.signatureReverify.request, { messageId });
		expect(await scheduledReverifies(t)).toBe(0);

		sessionMocks.userId = 'user-A';
		sessionMocks.role = 'owner';
		await t.mutation(api.mail.mailbox.signatureReverify.request, { messageId });
		await t.mutation(api.mail.mailbox.signatureReverify.request, { messageId });
		expect(await scheduledReverifies(t)).toBe(1);
	});

	it('an unscoped verdict is never written, and a scoped one is not overwritten', async () => {
		const { t, mailboxId, sender } = await setup();
		const scoped: InboundSignatureInfo = {
			isSigned: true,
			isSignatureValid: false,
			keySource: 'pinned',
			scope: 'mime',
		};
		const messageId = await seedStored(t, mailboxId, null, scoped);

		await t.mutation(internal.mail.mailbox.signatureReverify.apply, {
			messageId,
			info: { ...LEGACY_VERIFIED(sender.fingerprint), scope: 'mime' },
		});
		const legacyId = await seedStored(t, mailboxId, null, LEGACY_VERIFIED(sender.fingerprint));
		await t.mutation(internal.mail.mailbox.signatureReverify.apply, {
			messageId: legacyId,
			info: { ...LEGACY_VERIFIED(sender.fingerprint), isSignatureValid: true },
		});

		await t.run(async (ctx) => {
			expect((await ctx.db.get(messageId))!.inboundSignatureInfo).toEqual(scoped);
			expect((await ctx.db.get(legacyId))!.inboundSignatureInfo).toEqual(
				LEGACY_VERIFIED(sender.fingerprint)
			);
		});
	});
});
