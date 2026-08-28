/**
 * `mail.mailbox.messages.getMessageDetails` — the read behind the reader's
 * "message details" disclosure (UX plan idea 52).
 *
 * The panel exists to make the sender badge's claims checkable, so the contract
 * has two halves and both are locked here:
 *
 *   - it returns the header facts the panel renders, with a verdict the message
 *     never carried coming back ABSENT rather than defaulted (the panel must not
 *     invent a check nobody ran), and
 *   - it is recipient-scoped: a caller with no session gets `null`, not a header
 *     dump for someone else's mail.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { DatabaseWriter } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { modules, seedMailbox } from './helpers.testlib';

// The reader queries are soft-auth; an org owner reads any mailbox in the org,
// and an anonymous caller resolves no session at all.
const sessionMocks = vi.hoisted(() => ({
	getBetterAuthSessionWithRole: vi.fn(),
}));
vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		getBetterAuthSessionWithRole: sessionMocks.getBetterAuthSessionWithRole,
	};
});
function setOwnerSession() {
	sessionMocks.getBetterAuthSessionWithRole.mockResolvedValue({
		userId: 'test-user',
		role: 'owner',
		activeOrganizationId: 'test-org',
	});
}
function setAnonymous() {
	sessionMocks.getBetterAuthSessionWithRole.mockResolvedValue(null);
}

async function setup(t: ReturnType<typeof convexTest>): Promise<Id<'_storage'>> {
	const mailboxId = await seedMailbox(t, {
		userId: 'test-user',
		organizationId: 'test-org',
		address: 'me@example.com',
		domain: 'example.com',
	});
	let rawStorageId!: Id<'_storage'>;
	await t.run(async (ctx: { db: DatabaseWriter; storage: { store: (b: Blob) => unknown } }) => {
		const now = Date.now();
		// Both folders: a DMARC fail under a strict policy is routed to Spam, so a
		// mailbox with only an inbox would fail delivery before the read under test.
		for (const [name, role] of [
			['INBOX', 'inbox'],
			['Spam', 'spam'],
		] as const) {
			await ctx.db.insert('mailFolders', {
				mailboxId,
				name,
				role,
				uidValidity: now,
				uidNext: 1,
				highestModseq: 1,
				totalCount: 0,
				unseenCount: 0,
				subscribed: true,
				createdAt: now,
				updatedAt: now,
			});
		}
		rawStorageId = (await ctx.storage.store(new Blob(['x']))) as Id<'_storage'>;
	});
	return rawStorageId;
}

const baseDelivery = (rawStorageId: Id<'_storage'>, messageId: string) => ({
	rawStorageId,
	rawSize: 42,
	recipientAddress: 'me@example.com',
	from: 'Alice <alice@sender.example>',
	to: ['me@example.com'],
	cc: [],
	bcc: [],
	subject: 'Header facts',
	textBodyInline: 'hi',
	snippet: 'hi',
	messageId,
	receivedAt: Date.now(),
	attachments: [],
});

describe('getMessageDetails', () => {
	it('returns the header facts the details panel renders', async () => {
		setOwnerSession();
		const t = convexTest(schema, modules);
		const rawStorageId = await setup(t);

		const result = await t.mutation(internal.mail.delivery.deliverToMailbox, {
			...baseDelivery(rawStorageId, '<details-1@sender.example>'),
			replyTo: 'billing@other-domain.example',
			spfResult: 'pass',
			dkimResult: 'pass',
			dmarcResult: 'fail',
			dmarcPolicy: 'reject',
			envelopeFromDomain: 'bounce.sender.example',
			dkimSigningDomain: 'sender.example',
		});
		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		// The ARC rescue is written by the delivery pipeline's trusted-forwarder
		// branch (covered in arcOverride.test.ts); this read only has to surface
		// the two fields it leaves behind, so they are patched in directly.
		const messageId = result.messageId;
		await t.run(async (ctx: { db: DatabaseWriter }) => {
			await ctx.db.patch(messageId, { dmarcOverride: 'arc', arcSealer: 'lists.example' });
		});

		const details = await t.query(api.mail.mailbox.messages.getMessageDetails, {
			messageId: result.messageId,
		});
		expect(details).toMatchObject({
			fromAddress: 'alice@sender.example',
			fromName: 'Alice',
			replyToAddress: 'billing@other-domain.example',
			spfResult: 'pass',
			dkimResult: 'pass',
			dmarcResult: 'fail',
			dmarcPolicy: 'reject',
			envelopeFromDomain: 'bounce.sender.example',
			dkimSigningDomain: 'sender.example',
			dmarcOverride: 'arc',
			arcSealer: 'lists.example',
			rawSize: 42,
		});
	});

	it('leaves a check the message never carried ABSENT rather than defaulting it', async () => {
		setOwnerSession();
		const t = convexTest(schema, modules);
		const rawStorageId = await setup(t);

		const result = await t.mutation(internal.mail.delivery.deliverToMailbox, {
			...baseDelivery(rawStorageId, '<details-legacy@sender.example>'),
		});
		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		const details = await t.query(api.mail.mailbox.messages.getMessageDetails, {
			messageId: result.messageId,
		});
		expect(details).toBeTruthy();
		expect(details?.spfResult).toBeUndefined();
		expect(details?.dkimResult).toBeUndefined();
		expect(details?.dmarcResult).toBeUndefined();
		expect(details?.envelopeFromDomain).toBeUndefined();
		expect(details?.dmarcOverride).toBeUndefined();
		expect(details?.arcSealer).toBeUndefined();
	});

	it('returns null for a caller with no session — headers are recipient-scoped', async () => {
		setOwnerSession();
		const t = convexTest(schema, modules);
		const rawStorageId = await setup(t);

		const result = await t.mutation(internal.mail.delivery.deliverToMailbox, {
			...baseDelivery(rawStorageId, '<details-anon@sender.example>'),
			spfResult: 'pass',
		});
		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		setAnonymous();
		const details = await t.query(api.mail.mailbox.messages.getMessageDetails, {
			messageId: result.messageId,
		});
		expect(details).toBeNull();
	});
});
