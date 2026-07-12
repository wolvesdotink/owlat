/**
 * Sealed Mail A2 — the reader queries surface the inbound auth verdicts.
 *
 * A1 persisted the four SPF/DKIM/DMARC verdicts and the two DMARC alignment
 * inputs (envelope MAIL FROM domain + DKIM d= domain) on `mailMessages`. This
 * piece threads them out through the reader query that backs
 * `PostboxThreadReader.vue` so A3 can render an honest sender badge. The
 * queries return the full message document, so the contract is simply that
 * nothing along the read path strips the six fields.
 *
 * This locks that contract: a message seeded WITH all six fields reads them
 * back through `mail.mailbox.getMessage`, and a legacy message seeded WITHOUT
 * them surfaces them ABSENT (never defaulted — the reader must not claim a
 * verdict we never computed).
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { DatabaseWriter } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';

// See delivery.test.ts / ingestAuthVerdicts.test.ts: the `../../**` glob omits
// the `mail/` dir it climbed through, so merge a second glob rooted at `mail/`
// and re-prefix its keys so `t.query(api.mail.…)` resolves the modules.
const rootGlob = import.meta.glob('../../**/*.*s');
const mailGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../mail/'),
		mod,
	])
);
const allModules = { ...rootGlob, ...mailGlob };
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('llmProvider')
	)
);

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

async function insertMailbox(ctx: { db: DatabaseWriter }): Promise<Id<'mailboxes'>> {
	const now = Date.now();
	return ctx.db.insert('mailboxes', {
		userId: 'test-user',
		organizationId: 'test-org',
		address: 'me@example.com',
		domain: 'example.com',
		status: 'active',
		usedBytes: 0,
		uidValidity: now,
		createdAt: now,
		updatedAt: now,
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
	let rawStorageId!: Id<'_storage'>;
	await t.run(async (ctx) => {
		const mailboxId = await insertMailbox(ctx);
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

describe('mail.mailbox.getMessage — reader surfaces inbound auth verdicts (Sealed Mail A2)', () => {
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

		const message = await t.query(api.mail.mailbox.getMessage, {
			messageId: result.messageId,
		});
		expect(message).not.toBeNull();
		expect(message?.spfResult).toBe('pass');
		expect(message?.dkimResult).toBe('pass');
		expect(message?.dmarcResult).toBe('pass');
		expect(message?.dmarcPolicy).toBe('reject');
		expect(message?.envelopeFromDomain).toBe('sender.example');
		expect(message?.dkimSigningDomain).toBe('sender.example');
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

		const message = await t.query(api.mail.mailbox.getMessage, {
			messageId: result.messageId,
		});
		expect(message).not.toBeNull();
		expect(message?.spfResult).toBeUndefined();
		expect(message?.dkimResult).toBeUndefined();
		expect(message?.dmarcResult).toBeUndefined();
		expect(message?.dmarcPolicy).toBeUndefined();
		expect(message?.envelopeFromDomain).toBeUndefined();
		expect(message?.dkimSigningDomain).toBeUndefined();
	});
});
