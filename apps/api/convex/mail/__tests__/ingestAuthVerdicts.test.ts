/**
 * Sealed Mail A1 — auth-verdict + DMARC-alignment persistence on the
 * personal-mailbox path.
 *
 * `mailMessages` has carried the SPF/DKIM/DMARC verdicts since inbound auth
 * landed; this change adds the two DMARC *alignment inputs* the MTA now
 * forwards beside them — the SMTP envelope MAIL FROM domain and the d= domain
 * of the passing DKIM signature. This asserts `deliverToMailbox` persists both
 * the verdicts and the alignment domains, and that an old-MTA delivery with
 * the alignment fields absent stores them absent (never fabricates alignment
 * we did not verify).
 */

import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { DatabaseWriter } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';

// See delivery.test.ts: the `../../**` glob omits the `mail/` dir it climbed
// through, so merge a second glob rooted at `mail/` and re-prefix its keys.
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

async function setupMailbox(t: ReturnType<typeof convexTest>): Promise<Id<'_storage'>> {
	let rawStorageId!: Id<'_storage'>;
	await t.run(async (ctx) => {
		const mailboxId = await insertMailbox(ctx);
		await insertFolder(ctx, mailboxId, 'INBOX', 'inbox');
		await insertFolder(ctx, mailboxId, 'Spam', 'spam');
		rawStorageId = await ctx.storage.store(new Blob(['x']));
	});
	return rawStorageId;
}

describe('mail.delivery.deliverToMailbox — auth verdicts + DMARC alignment (Sealed Mail A1)', () => {
	it('persists SPF/DKIM/DMARC verdicts AND the two DMARC alignment domains', async () => {
		const t = convexTest(schema, modules);
		const rawStorageId = await setupMailbox(t);

		const result = await t.mutation(internal.mail.delivery.deliverToMailbox, {
			rawStorageId,
			rawSize: 1,
			recipientAddress: 'me@example.com',
			from: 'Alice <alice@sender.example>',
			to: ['me@example.com'],
			cc: [],
			bcc: [],
			subject: 'Aligned mail',
			textBodyInline: 'hi',
			snippet: 'hi',
			messageId: '<align-1@sender.example>',
			receivedAt: Date.now(),
			attachments: [],
			spfResult: 'pass',
			dkimResult: 'pass',
			dmarcResult: 'pass',
			dmarcPolicy: 'reject',
			envelopeFromDomain: 'sender.example',
			dkimSigningDomain: 'sender.example',
		});
		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		await t.run(async (ctx: { db: DatabaseWriter }) => {
			const msg = await ctx.db.get(result.messageId);
			expect(msg?.spfResult).toBe('pass');
			expect(msg?.dkimResult).toBe('pass');
			expect(msg?.dmarcResult).toBe('pass');
			expect(msg?.dmarcPolicy).toBe('reject');
			expect(msg?.envelopeFromDomain).toBe('sender.example');
			expect(msg?.dkimSigningDomain).toBe('sender.example');
		});
	});

	it('stores the alignment domains as ABSENT when an old MTA omits them', async () => {
		const t = convexTest(schema, modules);
		const rawStorageId = await setupMailbox(t);

		const result = await t.mutation(internal.mail.delivery.deliverToMailbox, {
			rawStorageId,
			rawSize: 1,
			recipientAddress: 'me@example.com',
			from: 'Carol <carol@sender.example>',
			to: ['me@example.com'],
			cc: [],
			bcc: [],
			subject: 'Legacy mail',
			textBodyInline: 'hi',
			snippet: 'hi',
			messageId: '<align-old-1@sender.example>',
			receivedAt: Date.now(),
			attachments: [],
			// Verdicts present, but no alignment domains — an older MTA.
			spfResult: 'pass',
			dkimResult: 'pass',
			dmarcResult: 'pass',
		});
		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		await t.run(async (ctx: { db: DatabaseWriter }) => {
			const msg = await ctx.db.get(result.messageId);
			expect(msg?.spfResult).toBe('pass');
			expect(msg?.envelopeFromDomain).toBeUndefined();
			expect(msg?.dkimSigningDomain).toBeUndefined();
		});
	});
});
