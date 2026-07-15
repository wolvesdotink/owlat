/**
 * Sealed Mail A2 — the reader queries surface the inbound auth verdicts.
 *
 * A1 persisted the four SPF/DKIM/DMARC verdicts and the two DMARC alignment
 * inputs (envelope MAIL FROM domain + DKIM d= domain) on `mailMessages`. This
 * piece threads them out through the reader queries that back
 * `PostboxThreadReader.vue` so A3 can render an honest sender badge. The
 * conversation view subscribes to `mail.mailbox.listThreadMessages`, and the
 * deep-link fallback uses `mail.mailbox.getMessage`; both return the full
 * message document, so the contract is simply that nothing along either read
 * path strips the six fields.
 *
 * This locks that contract on BOTH queries: a message seeded WITH all six
 * fields reads them back, and a legacy message seeded WITHOUT them surfaces
 * them ABSENT (never defaulted — the reader must not claim a verdict we never
 * computed).
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { DatabaseWriter } from '../../_generated/server';
import type { Doc, Id } from '../../_generated/dataModel';
import { modules, seedMailbox } from './helpers.testlib';

// Reader queries are soft-auth; an org owner reads any mailbox in the org.
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

async function insertFolder(
	ctx: { db: DatabaseWriter },
	mailboxId: Id<'mailboxes'>,
	name: string,
	role: 'inbox' | 'spam'
): Promise<void> {
	const now = Date.now();
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

async function setup(t: ReturnType<typeof convexTest>): Promise<Id<'_storage'>> {
	const mailboxId = await seedMailbox(t, {
		userId: 'test-user',
		organizationId: 'test-org',
		address: 'me@example.com',
		domain: 'example.com',
	});
	let rawStorageId!: Id<'_storage'>;
	await t.run(async (ctx) => {
		await insertFolder(ctx, mailboxId, 'INBOX', 'inbox');
		await insertFolder(ctx, mailboxId, 'Spam', 'spam');
		rawStorageId = await ctx.storage.store(new Blob(['x']));
	});
	return rawStorageId;
}

const baseDelivery = (rawStorageId: Id<'_storage'>, messageId: string) => ({
	rawStorageId,
	rawSize: 1,
	recipientAddress: 'me@example.com',
	from: 'Alice <alice@sender.example>',
	to: ['me@example.com'],
	cc: [],
	bcc: [],
	subject: 'Reader verdicts',
	textBodyInline: 'hi',
	snippet: 'hi',
	messageId,
	receivedAt: Date.now(),
	attachments: [],
});

/** The six A1 fields the reader must surface (present or absent, never defaulted). */
type AuthVerdictFields = Pick<
	Doc<'mailMessages'>,
	| 'spfResult'
	| 'dkimResult'
	| 'dmarcResult'
	| 'dmarcPolicy'
	| 'envelopeFromDomain'
	| 'dkimSigningDomain'
>;

function expectSeededVerdicts(m: AuthVerdictFields | null | undefined): void {
	expect(m).toBeTruthy();
	expect(m?.spfResult).toBe('pass');
	expect(m?.dkimResult).toBe('pass');
	expect(m?.dmarcResult).toBe('pass');
	expect(m?.dmarcPolicy).toBe('reject');
	expect(m?.envelopeFromDomain).toBe('sender.example');
	expect(m?.dkimSigningDomain).toBe('sender.example');
}

function expectAbsentVerdicts(m: AuthVerdictFields | null | undefined): void {
	expect(m).toBeTruthy();
	expect(m?.spfResult).toBeUndefined();
	expect(m?.dkimResult).toBeUndefined();
	expect(m?.dmarcResult).toBeUndefined();
	expect(m?.dmarcPolicy).toBeUndefined();
	expect(m?.envelopeFromDomain).toBeUndefined();
	expect(m?.dkimSigningDomain).toBeUndefined();
}

describe('mail reader queries — surface inbound auth verdicts (Sealed Mail A2)', () => {
	it('returns the four verdicts and both alignment domains for a seeded message', async () => {
		setOwnerSession();
		const t = convexTest(schema, modules);
		const rawStorageId = await setup(t);

		const result = await t.mutation(internal.mail.delivery.deliverToMailbox, {
			...baseDelivery(rawStorageId, '<reader-1@sender.example>'),
			spfResult: 'pass',
			dkimResult: 'pass',
			dmarcResult: 'pass',
			dmarcPolicy: 'reject',
			envelopeFromDomain: 'sender.example',
			dkimSigningDomain: 'sender.example',
		});
		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		// Deep-link fallback query.
		const message = await t.query(api.mail.mailbox.getMessage, {
			messageId: result.messageId,
		});
		expectSeededVerdicts(message);

		// Query the reader actually subscribes to for the conversation view.
		const thread = await t.query(api.mail.mailbox.listThreadMessages, {
			messageId: result.messageId,
		});
		const threadMessage = thread?.messages.find((m) => m._id === result.messageId);
		expectSeededVerdicts(threadMessage);
	});

	it('surfaces all six fields as ABSENT for a legacy message that carried none', async () => {
		setOwnerSession();
		const t = convexTest(schema, modules);
		const rawStorageId = await setup(t);

		const result = await t.mutation(internal.mail.delivery.deliverToMailbox, {
			...baseDelivery(rawStorageId, '<reader-legacy@sender.example>'),
			// An older MTA / pre-A1 row: no verdicts, no alignment inputs.
		});
		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		// Deep-link fallback query.
		const message = await t.query(api.mail.mailbox.getMessage, {
			messageId: result.messageId,
		});
		expectAbsentVerdicts(message);

		// Query the reader actually subscribes to for the conversation view.
		const thread = await t.query(api.mail.mailbox.listThreadMessages, {
			messageId: result.messageId,
		});
		const threadMessage = thread?.messages.find((m) => m._id === result.messageId);
		expectAbsentVerdicts(threadMessage);
	});
});
