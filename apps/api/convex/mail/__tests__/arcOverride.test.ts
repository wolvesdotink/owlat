/**
 * Sealed Mail A5 — inbound ARC override on the personal-mailbox delivery path.
 *
 * A mailing-list / forwarded message fails DMARC (the list broke the author's
 * DKIM) and would normally be routed to Spam on a quarantine/reject policy. When
 * a TRUSTED forwarder's validated ARC chain (RFC 8617) attests the original
 * passed, `deliverToMailbox` must instead KEEP it in the inbox and record
 * `dmarcOverride: 'arc'` + the honoured sealer. This asserts the rescue fires
 * ONLY for a trusted sealer, respects the operator's editable allow-list
 * (including an explicit empty list = off), and never weakens the existing
 * DMARC→Spam routing for an ordinary spoof.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { DatabaseWriter } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { modules } from './testModules';

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

/** The folder role a delivered message landed in, and its override fields. */
async function landing(
	t: ReturnType<typeof convexTest>,
	messageId: Id<'mailMessages'>
): Promise<{ role?: string; dmarcOverride?: string; arcSealer?: string }> {
	return t.run(async (ctx: { db: DatabaseWriter }) => {
		const msg = await ctx.db.get(messageId);
		if (!msg) return {};
		const folder = await ctx.db.get(msg.folderId);
		return {
			role: folder?.role,
			dmarcOverride: msg.dmarcOverride,
			arcSealer: msg.arcSealer,
		};
	});
}

/** A DMARC quarantine-fail delivery with the given ARC verdict fields. */
function deliver(
	t: ReturnType<typeof convexTest>,
	rawStorageId: Id<'_storage'>,
	messageId: string,
	arc: { arcCv?: string; arcSealerDomain?: string; arcAttestsOriginalPass?: boolean }
) {
	return t.mutation(internal.mail.delivery.deliverToMailbox, {
		rawStorageId,
		rawSize: 1,
		recipientAddress: 'me@example.com',
		from: 'Alice <alice@author.example>',
		to: ['me@example.com'],
		cc: [],
		bcc: [],
		subject: '[list] hello',
		textBodyInline: 'hi',
		snippet: 'hi',
		messageId,
		receivedAt: Date.now(),
		attachments: [],
		// A quarantine/reject DMARC fail — routed to Spam UNLESS ARC rescues it.
		dmarcResult: 'fail',
		dmarcPolicy: 'quarantine',
		...arc,
	});
}

describe('mail.delivery.deliverToMailbox — ARC override (Sealed Mail A5)', () => {
	it('RESCUES a DMARC fail from a trusted forwarder: inbox + dmarcOverride=arc', async () => {
		const t = convexTest(schema, modules);
		const rawStorageId = await setupMailbox(t);

		const result = await deliver(t, rawStorageId, '<arc-1@author.example>', {
			arcCv: 'pass',
			arcSealerDomain: 'lists.sourceforge.net', // in the seeded default list
			arcAttestsOriginalPass: true,
		});
		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		const land = await landing(t, result.messageId);
		expect(land.role).toBe('inbox');
		expect(land.dmarcOverride).toBe('arc');
		expect(land.arcSealer).toBe('lists.sourceforge.net');
	});

	it('does NOT rescue an untrusted sealer: routed to Spam, no override', async () => {
		const t = convexTest(schema, modules);
		const rawStorageId = await setupMailbox(t);

		const result = await deliver(t, rawStorageId, '<arc-2@author.example>', {
			arcCv: 'pass',
			arcSealerDomain: 'evil-forwarder.example',
			arcAttestsOriginalPass: true,
		});
		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		const land = await landing(t, result.messageId);
		expect(land.role).toBe('spam');
		expect(land.dmarcOverride).toBeUndefined();
		expect(land.arcSealer).toBeUndefined();
	});

	it('does NOT rescue a broken chain (cv!=pass) even from a trusted forwarder', async () => {
		const t = convexTest(schema, modules);
		const rawStorageId = await setupMailbox(t);

		const result = await deliver(t, rawStorageId, '<arc-3@author.example>', {
			arcCv: 'fail',
			arcSealerDomain: 'lists.sourceforge.net',
			arcAttestsOriginalPass: true,
		});
		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		const land = await landing(t, result.messageId);
		expect(land.role).toBe('spam');
		expect(land.dmarcOverride).toBeUndefined();
	});

	it('does NOT rescue when the sealer did not attest the original passed', async () => {
		const t = convexTest(schema, modules);
		const rawStorageId = await setupMailbox(t);

		const result = await deliver(t, rawStorageId, '<arc-4@author.example>', {
			arcCv: 'pass',
			arcSealerDomain: 'lists.sourceforge.net',
			arcAttestsOriginalPass: false,
		});
		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		const land = await landing(t, result.messageId);
		expect(land.role).toBe('spam');
	});

	it('respects an operator allow-list that EXPLICITLY excludes the default sealer', async () => {
		const t = convexTest(schema, modules);
		const rawStorageId = await setupMailbox(t);
		// An operator who trusts only their own list — a default sealer is no longer honoured.
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				trustedArcForwarders: ['my-own-list.example'],
				createdAt: Date.now(),
			});
		});

		const result = await deliver(t, rawStorageId, '<arc-5@author.example>', {
			arcCv: 'pass',
			arcSealerDomain: 'lists.sourceforge.net',
			arcAttestsOriginalPass: true,
		});
		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		const land = await landing(t, result.messageId);
		expect(land.role).toBe('spam');
		expect(land.dmarcOverride).toBeUndefined();
	});

	it('honours a custom allow-list that INCLUDES the sealer', async () => {
		const t = convexTest(schema, modules);
		const rawStorageId = await setupMailbox(t);
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				trustedArcForwarders: ['my-own-list.example'],
				createdAt: Date.now(),
			});
		});

		const result = await deliver(t, rawStorageId, '<arc-6@author.example>', {
			arcCv: 'pass',
			arcSealerDomain: 'my-own-list.example',
			arcAttestsOriginalPass: true,
		});
		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		const land = await landing(t, result.messageId);
		expect(land.role).toBe('inbox');
		expect(land.dmarcOverride).toBe('arc');
		expect(land.arcSealer).toBe('my-own-list.example');
	});

	it('an explicit EMPTY allow-list disables the rescue entirely', async () => {
		const t = convexTest(schema, modules);
		const rawStorageId = await setupMailbox(t);
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				trustedArcForwarders: [],
				createdAt: Date.now(),
			});
		});

		const result = await deliver(t, rawStorageId, '<arc-7@author.example>', {
			arcCv: 'pass',
			arcSealerDomain: 'lists.sourceforge.net',
			arcAttestsOriginalPass: true,
		});
		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		const land = await landing(t, result.messageId);
		expect(land.role).toBe('spam');
	});

	it('does NOT let a single-label allow-list entry act as a TLD wildcard', async () => {
		const t = convexTest(schema, modules);
		const rawStorageId = await setupMailbox(t);
		// A malicious/typo'd bare `com` entry must not trust every `.com` sealer,
		// even though a real settings.update sanitizes it away — this pins the
		// delivery-path predicate itself as fail-closed.
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				trustedArcForwarders: ['com'],
				createdAt: Date.now(),
			});
		});

		const result = await deliver(t, rawStorageId, '<arc-9@author.example>', {
			arcCv: 'pass',
			arcSealerDomain: 'evil.com',
			arcAttestsOriginalPass: true,
		});
		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		const land = await landing(t, result.messageId);
		expect(land.role).toBe('spam');
		expect(land.dmarcOverride).toBeUndefined();
	});

	it('leaves an ordinary DMARC quarantine-fail (no ARC) routed to Spam', async () => {
		const t = convexTest(schema, modules);
		const rawStorageId = await setupMailbox(t);

		const result = await deliver(t, rawStorageId, '<arc-8@author.example>', {});
		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		const land = await landing(t, result.messageId);
		expect(land.role).toBe('spam');
		expect(land.dmarcOverride).toBeUndefined();
	});
});
