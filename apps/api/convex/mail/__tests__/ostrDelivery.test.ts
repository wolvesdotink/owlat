/**
 * OSTR tier on the personal-mailbox delivery path (plan §6.1, §12.2).
 *
 * The registry tier is a SIGNAL, not a gate. `deliverToMailbox` must persist
 * whatever tier the MTA resolved — so an operator can see what the registry
 * said before deciding to act on it — while only ever letting `flagged` change
 * where a message lands, only into Spam, and only while the `ostr` feature flag
 * is on. Everything else must be byte-identical to a delivery that carried no
 * tier at all, which is the shipped default.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { DatabaseWriter } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { modules } from '../../__tests__/testModulesWithoutNodeActions';
import type { OstrTier } from '../../ostr/signals';

async function setupMailbox(t: ReturnType<typeof convexTest>): Promise<Id<'_storage'>> {
	let rawStorageId!: Id<'_storage'>;
	await t.run(async (ctx) => {
		const now = Date.now();
		const mailboxId = await ctx.db.insert('mailboxes', {
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
		rawStorageId = await ctx.storage.store(new Blob(['x']));
	});
	return rawStorageId;
}

/**
 * Turn the `ostr` flag on for the instance (it ships OFF). `postbox` goes on
 * too because `ostr` requires it — personal mail is the only plane this signal
 * has an effect on, so `resolveFlags` cascades `ostr` back to false without it.
 */
async function enableOstr(t: ReturnType<typeof convexTest>): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('instanceSettings', {
			featureFlags: { postbox: true, ostr: true },
			createdAt: Date.now(),
		});
	});
}

/** An otherwise unremarkable delivery — authenticated, clean, no spam signal. */
function deliver(
	t: ReturnType<typeof convexTest>,
	rawStorageId: Id<'_storage'>,
	messageId: string,
	ostr: { ostrTier?: OstrTier } = {}
) {
	return t.mutation(internal.mail.delivery.deliverToMailbox, {
		rawStorageId,
		rawSize: 1,
		recipientAddress: 'me@example.com',
		from: 'Alice <alice@sender.example>',
		to: ['me@example.com'],
		cc: [],
		bcc: [],
		subject: 'Quarterly update',
		textBodyInline: 'hi',
		snippet: 'hi',
		messageId,
		receivedAt: Date.now(),
		attachments: [],
		spamScore: 0,
		spamVerdict: 'ham',
		spfResult: 'pass',
		dkimResult: 'pass',
		dmarcResult: 'pass',
		...ostr,
	});
}

/** The folder role a delivered message landed in, plus its stored tier. */
async function landing(
	t: ReturnType<typeof convexTest>,
	messageId: Id<'mailMessages'>
): Promise<{ role?: string; ostrTier?: string }> {
	return t.run(async (ctx: { db: DatabaseWriter }) => {
		const msg = await ctx.db.get(messageId);
		if (!msg) return {};
		const folder = await ctx.db.get(msg.folderId);
		return { role: folder?.role, ostrTier: msg.ostrTier };
	});
}

describe('mail.delivery.deliverToMailbox — OSTR tier', () => {
	it('routes a FLAGGED sender to Spam when the ostr flag is on, and stores the tier', async () => {
		const t = convexTest(schema, modules);
		const rawStorageId = await setupMailbox(t);
		await enableOstr(t);

		const result = await deliver(t, rawStorageId, '<ostr-1@sender.example>', {
			ostrTier: 'flagged',
		});
		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		const land = await landing(t, result.messageId);
		expect(land.role).toBe('spam');
		expect(land.ostrTier).toBe('flagged');
	});

	it('leaves a FLAGGED sender in the inbox while the flag is off — but records the tier', async () => {
		const t = convexTest(schema, modules);
		const rawStorageId = await setupMailbox(t);
		// No instanceSettings row at all: the shipped default, flag off.

		const result = await deliver(t, rawStorageId, '<ostr-2@sender.example>', {
			ostrTier: 'flagged',
		});
		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		const land = await landing(t, result.messageId);
		expect(land.role).toBe('inbox');
		expect(land.ostrTier).toBe('flagged');
	});

	it('leaves a FLAGGED sender in the inbox when ostr is on but postbox is off', async () => {
		const t = convexTest(schema, modules);
		const rawStorageId = await setupMailbox(t);
		// `ostr` requires `postbox`: on a deployment without the personal-mail
		// plane the toggle resolves back to off, and must not route anything.
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				featureFlags: { postbox: false, ostr: true },
				createdAt: Date.now(),
			});
		});

		const result = await deliver(t, rawStorageId, '<ostr-nopostbox@sender.example>', {
			ostrTier: 'flagged',
		});
		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		const land = await landing(t, result.messageId);
		expect(land.role).toBe('inbox');
		expect(land.ostrTier).toBe('flagged');
	});

	it('never reroutes WARNED or anything below it, even with the flag on', async () => {
		const t = convexTest(schema, modules);
		const rawStorageId = await setupMailbox(t);
		await enableOstr(t);

		for (const tier of ['warned', 'trusted', 'establishing', 'unknown'] as const) {
			const result = await deliver(t, rawStorageId, `<ostr-${tier}@sender.example>`, {
				ostrTier: tier,
			});
			expect('messageId' in result, tier).toBe(true);
			if (!('messageId' in result)) return;

			const land = await landing(t, result.messageId);
			expect(land.role, tier).toBe('inbox');
			expect(land.ostrTier, tier).toBe(tier);
		}
	});

	it('delivers exactly as today when no tier is supplied', async () => {
		const t = convexTest(schema, modules);
		const rawStorageId = await setupMailbox(t);
		await enableOstr(t);

		const result = await deliver(t, rawStorageId, '<ostr-none@sender.example>');
		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		const land = await landing(t, result.messageId);
		expect(land.role).toBe('inbox');
		expect(land.ostrTier).toBeUndefined();
	});

	it('does not rescue a message the existing signals already condemn', async () => {
		const t = convexTest(schema, modules);
		const rawStorageId = await setupMailbox(t);
		await enableOstr(t);

		// A `trusted` tier is not a bypass: an enforcing DMARC fail still lands in
		// Spam. OSTR only ever adds a reason to filter, never removes one.
		const result = await t.mutation(internal.mail.delivery.deliverToMailbox, {
			rawStorageId,
			rawSize: 1,
			recipientAddress: 'me@example.com',
			from: 'Mallory <mallory@sender.example>',
			to: ['me@example.com'],
			cc: [],
			bcc: [],
			subject: 'Spoofed',
			textBodyInline: 'hi',
			snippet: 'hi',
			messageId: '<ostr-trusted-spoof@sender.example>',
			receivedAt: Date.now(),
			attachments: [],
			spamScore: 0,
			spamVerdict: 'ham',
			dmarcResult: 'fail',
			dmarcPolicy: 'reject',
			ostrTier: 'trusted',
		});
		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		const land = await landing(t, result.messageId);
		expect(land.role).toBe('spam');
		expect(land.ostrTier).toBe('trusted');
	});
});
