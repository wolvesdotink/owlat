/**
 * mail.delivery.deliverToMailbox — auth-result + scan-verdict storage and
 * spam folder routing.
 *
 * PR-38 regression guard. The MTA now threads the SPF verdict (and any other
 * auth/scan verdicts present) onto the `inbound.mailbox.received` payload; the
 * webhook hands them to this mutation. This test pins the Convex end of that
 * pipeline: the verdicts are persisted on the mailMessages row, and a `spam`
 * verdict (or an SPF/DMARC `fail`) lands the message in the Spam folder rather
 * than the inbox (delivery.ts §4, RFC 8601).
 */

import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { DatabaseWriter } from '../_generated/server';
import type { Id } from '../_generated/dataModel';

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('llmProvider'),
	),
);

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
	role: 'inbox' | 'spam',
): Promise<Id<'mailFolders'>> {
	const now = Date.now();
	return ctx.db.insert('mailFolders', {
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

interface DeliverOverrides {
	messageId: string;
	spfResult?: string;
	dkimResult?: string;
	dmarcResult?: string;
	dmarcPolicy?: string;
	spamVerdict?: 'ham' | 'spam' | 'quarantine';
	virusVerdict?: 'clean' | 'infected' | 'skipped';
}

async function deliver(
	t: ReturnType<typeof convexTest>,
	rawStorageId: Id<'_storage'>,
	overrides: DeliverOverrides,
): Promise<{ messageId: Id<'mailMessages'> } | { skipped: true }> {
	return t.mutation(internal.mail.delivery.deliverToMailbox, {
		rawStorageId,
		rawSize: 1,
		recipientAddress: 'me@example.com',
		from: 'sender@isp.example',
		to: ['me@example.com'],
		cc: [],
		bcc: [],
		subject: 'hello',
		textBodyInline: 'hi',
		snippet: 'hi',
		receivedAt: Date.now(),
		attachments: [],
		...overrides,
	});
}

describe('deliverToMailbox — auth/scan verdict storage + spam routing (PR-38)', () => {
	it('persists spfResult/dmarcResult and routes an SPF+DMARC fail to the Spam folder', async () => {
		const t = convexTest(schema, modules);
		let mailboxId!: Id<'mailboxes'>;
		let inboxId!: Id<'mailFolders'>;
		let spamId!: Id<'mailFolders'>;
		let rawStorageId!: Id<'_storage'>;
		await t.run(async (ctx) => {
			mailboxId = await insertMailbox(ctx);
			inboxId = await insertFolder(ctx, mailboxId, 'INBOX', 'inbox');
			spamId = await insertFolder(ctx, mailboxId, 'Spam', 'spam');
			rawStorageId = await ctx.storage.store(new Blob(['x']));
		});

		const result = await deliver(t, rawStorageId, {
			messageId: '<spam-1@isp.example>',
			spfResult: 'fail',
			dmarcResult: 'fail',
			spamVerdict: 'spam',
		});
		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		await t.run(async (ctx: { db: DatabaseWriter }) => {
			const msg = await ctx.db.get(result.messageId);
			expect(msg?.spfResult).toBe('fail');
			expect(msg?.dmarcResult).toBe('fail');
			expect(msg?.spamVerdict).toBe('spam');
			// Spam verdict → Spam folder, not the inbox.
			expect(msg?.folderId).toBe(spamId);
			expect(msg?.folderId).not.toBe(inboxId);
		});
	});

	it('routes a DMARC quarantine fail to Spam without a spam content verdict (PR-37)', async () => {
		// A spoofed message: DMARC fails and the From-domain published
		// p=quarantine. The content scan finds nothing spammy (subject "hello",
		// body "hi") so the content verdict is `ham`; the move to Spam is driven
		// purely by the enforcing DMARC policy (RFC 7489 §6.6.2), not the verdict.
		const t = convexTest(schema, modules);
		let mailboxId!: Id<'mailboxes'>;
		let inboxId!: Id<'mailFolders'>;
		let spamId!: Id<'mailFolders'>;
		let rawStorageId!: Id<'_storage'>;
		await t.run(async (ctx) => {
			mailboxId = await insertMailbox(ctx);
			inboxId = await insertFolder(ctx, mailboxId, 'INBOX', 'inbox');
			spamId = await insertFolder(ctx, mailboxId, 'Spam', 'spam');
			rawStorageId = await ctx.storage.store(new Blob(['x']));
		});

		const result = await deliver(t, rawStorageId, {
			messageId: '<dmarc-spoof-1@attacker.example>',
			spfResult: 'pass',
			dmarcResult: 'fail',
			dmarcPolicy: 'quarantine',
		});
		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		await t.run(async (ctx: { db: DatabaseWriter }) => {
			const msg = await ctx.db.get(result.messageId);
			expect(msg?.dmarcResult).toBe('fail');
			expect(msg?.dmarcPolicy).toBe('quarantine');
			// Clean content → `ham`; the routing decision is DMARC-driven, not
			// content-verdict-driven.
			expect(msg?.spamVerdict).toBe('ham');
			// Enforcing DMARC policy → Spam folder, not the inbox.
			expect(msg?.folderId).toBe(spamId);
			expect(msg?.folderId).not.toBe(inboxId);
		});
	});

	it('does NOT move a p=none DMARC fail (monitor-only) out of the inbox', async () => {
		// A `p=none` fail is report-only — record the verdict but keep the
		// message in the inbox (RFC 7489 §6.3).
		const t = convexTest(schema, modules);
		let mailboxId!: Id<'mailboxes'>;
		let inboxId!: Id<'mailFolders'>;
		let rawStorageId!: Id<'_storage'>;
		await t.run(async (ctx) => {
			mailboxId = await insertMailbox(ctx);
			inboxId = await insertFolder(ctx, mailboxId, 'INBOX', 'inbox');
			await insertFolder(ctx, mailboxId, 'Spam', 'spam');
			rawStorageId = await ctx.storage.store(new Blob(['x']));
		});

		const result = await deliver(t, rawStorageId, {
			messageId: '<dmarc-none-1@sender.example>',
			dmarcResult: 'fail',
			dmarcPolicy: 'none',
		});
		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		await t.run(async (ctx: { db: DatabaseWriter }) => {
			const msg = await ctx.db.get(result.messageId);
			expect(msg?.dmarcResult).toBe('fail');
			expect(msg?.dmarcPolicy).toBe('none');
			expect(msg?.folderId).toBe(inboxId);
		});
	});

	it('stores a passing SPF verdict and keeps a clean message in the inbox', async () => {
		const t = convexTest(schema, modules);
		let mailboxId!: Id<'mailboxes'>;
		let inboxId!: Id<'mailFolders'>;
		let rawStorageId!: Id<'_storage'>;
		await t.run(async (ctx) => {
			mailboxId = await insertMailbox(ctx);
			inboxId = await insertFolder(ctx, mailboxId, 'INBOX', 'inbox');
			await insertFolder(ctx, mailboxId, 'Spam', 'spam');
			rawStorageId = await ctx.storage.store(new Blob(['x']));
		});

		const result = await deliver(t, rawStorageId, {
			messageId: '<ham-1@isp.example>',
			spfResult: 'pass',
			dkimResult: 'pass',
			dmarcResult: 'pass',
			spamVerdict: 'ham',
		});
		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		await t.run(async (ctx: { db: DatabaseWriter }) => {
			const msg = await ctx.db.get(result.messageId);
			expect(msg?.spfResult).toBe('pass');
			expect(msg?.dkimResult).toBe('pass');
			expect(msg?.dmarcResult).toBe('pass');
			expect(msg?.folderId).toBe(inboxId);
		});
	});
});
