/**
 * Sealed Mail A4 — sender-impersonation heuristics persisted at ingest.
 *
 * `deliverToMailbox` now computes two heuristics the content scanner cannot see
 * — is this the first message from this address into the mailbox, and does the
 * From domain look like a KNOWN contact's — and stores them on
 * `mailMessages.senderHeuristics` for the reader's sender badge. This asserts:
 * first-time-sender true on a fresh address and false once a prior message
 * exists, a lookalike-of-contact hit is persisted with the resembled domain,
 * and a homoglyph From domain sets fromDomainSpoofed.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { DatabaseWriter } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';

// See ingestAuthVerdicts.test.ts / delivery.test.ts: the `../../**` glob omits
// the `mail/` dir it climbed through, so merge a second glob rooted at `mail/`.
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

async function insertContact(ctx: { db: DatabaseWriter }, email: string): Promise<void> {
	const now = Date.now();
	await ctx.db.insert('contacts', {
		email,
		source: 'api',
		doiStatus: 'not_required',
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

const baseArgs = (
	rawStorageId: Id<'_storage'>,
	overrides: { from: string; subject: string; messageId: string }
) => ({
	rawStorageId,
	rawSize: 1,
	recipientAddress: 'me@example.com',
	to: ['me@example.com'],
	cc: [],
	bcc: [],
	textBodyInline: 'hi',
	snippet: 'hi',
	receivedAt: Date.now(),
	attachments: [],
	...overrides,
});

describe('mail.delivery.deliverToMailbox — sender heuristics (Sealed Mail A4)', () => {
	it('flags a first-time sender', async () => {
		const t = convexTest(schema, modules);
		const rawStorageId = await setupMailbox(t);

		const result = await t.mutation(
			internal.mail.delivery.deliverToMailbox,
			baseArgs(rawStorageId, {
				from: 'Alice <alice@newsender.example>',
				subject: 'First contact',
				messageId: '<first-1@newsender.example>',
			})
		);
		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		await t.run(async (ctx: { db: DatabaseWriter }) => {
			const msg = await ctx.db.get(result.messageId);
			expect(msg?.senderHeuristics?.firstTimeSender).toBe(true);
		});
	});

	it('does NOT flag first-time on a second message from the same address', async () => {
		const t = convexTest(schema, modules);
		const rawStorageId = await setupMailbox(t);

		await t.mutation(
			internal.mail.delivery.deliverToMailbox,
			baseArgs(rawStorageId, {
				from: 'Bob <bob@known.example>',
				subject: 'Msg one',
				messageId: '<known-1@known.example>',
			})
		);
		const second = await t.mutation(
			internal.mail.delivery.deliverToMailbox,
			baseArgs(rawStorageId, {
				from: 'Bob <bob@known.example>',
				subject: 'Msg two',
				messageId: '<known-2@known.example>',
			})
		);
		expect('messageId' in second).toBe(true);
		if (!('messageId' in second)) return;

		await t.run(async (ctx: { db: DatabaseWriter }) => {
			const msg = await ctx.db.get(second.messageId);
			// Not a first-time sender — and with no other signal, no object at all.
			expect(msg?.senderHeuristics?.firstTimeSender).not.toBe(true);
		});
	});

	it('persists a lookalike-of-known-contact hit with the resembled domain', async () => {
		const t = convexTest(schema, modules);
		const rawStorageId = await setupMailbox(t);
		await t.run(async (ctx) => {
			await insertContact(ctx, 'billing@paypal.com');
		});

		// paypa1.com — digit '1' for letter 'l', one edit from paypal.com.
		const result = await t.mutation(
			internal.mail.delivery.deliverToMailbox,
			baseArgs(rawStorageId, {
				from: 'Billing <billing@paypa1.com>',
				subject: 'Your invoice',
				messageId: '<look-1@paypa1.com>',
			})
		);
		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		await t.run(async (ctx: { db: DatabaseWriter }) => {
			const msg = await ctx.db.get(result.messageId);
			expect(msg?.senderHeuristics?.lookalikeOfContactDomain).toBe('paypal.com');
		});
	});

	it('does NOT flag a lookalike when the sender matches a contact domain exactly', async () => {
		const t = convexTest(schema, modules);
		const rawStorageId = await setupMailbox(t);
		await t.run(async (ctx) => {
			await insertContact(ctx, 'billing@paypal.com');
		});

		const result = await t.mutation(
			internal.mail.delivery.deliverToMailbox,
			baseArgs(rawStorageId, {
				from: 'Billing <billing@paypal.com>',
				subject: 'Real invoice',
				messageId: '<real-1@paypal.com>',
			})
		);
		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		await t.run(async (ctx: { db: DatabaseWriter }) => {
			const msg = await ctx.db.get(result.messageId);
			expect(msg?.senderHeuristics?.lookalikeOfContactDomain).toBeUndefined();
		});
	});

	it('sets fromDomainSpoofed for a homoglyph From domain', async () => {
		const t = convexTest(schema, modules);
		const rawStorageId = await setupMailbox(t);

		// paypаl.com — Cyrillic а (U+0430) mimicking Latin a.
		const spoofed = `paypаl.com`;
		const result = await t.mutation(
			internal.mail.delivery.deliverToMailbox,
			baseArgs(rawStorageId, {
				from: `Support <support@${spoofed}>`,
				subject: 'Account notice',
				messageId: '<spoof-1@example.invalid>',
			})
		);
		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		await t.run(async (ctx: { db: DatabaseWriter }) => {
			const msg = await ctx.db.get(result.messageId);
			expect(msg?.senderHeuristics?.fromDomainSpoofed).toBe(true);
		});
	});
});
