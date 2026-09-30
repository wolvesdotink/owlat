/**
 * Live Postbox mail → knowledge graph (`mail/liveKnowledge.ts`).
 *
 * Mail that arrives in a connected mailbox lands in `mailMessages`, which the
 * AI inbox's extraction effect never sees; before this hook, an instance whose
 * mail all came from connected mailboxes had an empty knowledge graph however
 * much mail arrived. Forward sync from someone else schedules one extraction;
 * everything that is not a person's live mail schedules none.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { v } from 'convex/values';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { internal } from '../../_generated/api';
import { internalAction } from '../../_generated/server';
import { modules as mailModules } from './helpers.testlib';

// The real extractor calls an LLM. Stand in for it with an action that records
// which messages reached it, so a test can tell "extracted" from "refused".
const extracted: string[] = [];
const modules = {
	...mailModules,
	'../../knowledge/extraction.ts': async () => ({
		extractFromMailMessage: internalAction({
			args: {
				mailMessageId: v.id('mailMessages'),
				contactIds: v.optional(v.array(v.id('contacts'))),
			},
			handler: async (_ctx, args) => {
				extracted.push(args.mailMessageId);
			},
		}),
	}),
};

beforeEach(() => {
	extracted.length = 0;
});

// Shaped like the credential-phishing mail a provider let into a real inbox: a
// support-team sender threatening restrictions, a password prompt, and a link
// whose text names a different site than it points to.
const PHISHING = {
	from: 'Support Team <support@page-help.example.com>',
	subject: 'Action required: your page will be restricted',
	textBodyInline:
		'Dear user, verify your password within 24 hours or your page will be restricted.',
	htmlBodyInline:
		'<p>Dear user, verify your password within 24 hours or your page will be restricted.</p>' +
		'<a href="https://paypa1.fake.xyz/login">https://www.example.com/support</a>',
};

const OWNER_ADDRESS = 'team@acme.test';

type Seeded = { accountId: Id<'externalMailAccounts'>; mailboxId: Id<'mailboxes'> };

async function seed(
	t: TestConvex<typeof schema>,
	flags: Record<string, boolean> = { ai: true, 'ai.knowledge': true }
): Promise<Seeded> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert('instanceSettings', { featureFlags: flags, createdAt: now });
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'user-A',
			organizationId: 'org-1',
			address: OWNER_ADDRESS,
			domain: 'acme.test',
			kind: 'external',
			scope: 'shared',
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		for (const role of ['inbox', 'sent'] as const) {
			await ctx.db.insert('mailFolders', {
				mailboxId,
				name: role.toUpperCase(),
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
		const accountId = await ctx.db.insert('externalMailAccounts', {
			userId: 'user-A',
			organizationId: 'org-1',
			mailboxId,
			scope: 'shared',
			imapHost: 'imap.acme.test',
			imapPort: 993,
			isImapSecure: true,
			smtpHost: 'smtp.acme.test',
			smtpPort: 465,
			isSmtpSecure: true,
			authMethod: 'password' as const,
			imapUsername: OWNER_ADDRESS,
			secretCiphertext: 'x',
			secretIv: 'x',
			secretAuthTag: 'x',
			secretEnvelopeVersion: 1,
			status: 'connected' as const,
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.patch(mailboxId, { externalAccountId: accountId });
		return { accountId, mailboxId };
	});
}

let nextUid = 0;

async function ingest(
	t: TestConvex<typeof schema>,
	seeded: Seeded,
	opts: {
		origin?: 'sync' | 'backfill';
		folderRole?: 'inbox' | 'sent';
		from?: string;
		antiLoopHeaders?: Record<string, string>;
		subject?: string;
		textBodyInline?: string;
		htmlBodyInline?: string;
	} = {}
): Promise<Id<'mailMessages'>> {
	const uid = ++nextUid;
	const rawStorageId = await t.run(async (ctx) => await ctx.storage.store(new Blob(['raw'])));
	const outcome = await t.mutation(internal.mail.external.delivery.ingestExternalMessage, {
		accountId: seeded.accountId,
		folderRole: opts.folderRole ?? 'inbox',
		remoteName: opts.folderRole === 'sent' ? 'Sent' : 'INBOX',
		remoteUid: uid,
		remoteUidValidity: 7,
		rawStorageId,
		rawSize: 3,
		from: opts.from ?? 'Sam <sam@customer.test>',
		to: [OWNER_ADDRESS],
		cc: [],
		bcc: [],
		subject: opts.subject ?? 'Renewal',
		textBodyInline:
			opts.textBodyInline ?? 'We decided to renew the contract for another year starting in March.',
		...(opts.htmlBodyInline ? { htmlBodyInline: opts.htmlBodyInline } : {}),
		messageId: `<m${uid}@customer.test>`,
		receivedAt: Date.now(),
		attachments: [],
		origin: opts.origin ?? 'sync',
		...(opts.antiLoopHeaders ? { antiLoopHeaders: opts.antiLoopHeaders } : {}),
	});
	if (!('messageId' in outcome)) throw new Error(`ingest skipped: ${outcome.skipped}`);
	return outcome.messageId;
}

/** Scheduled extraction jobs' message ids (inspected, never executed). */
async function extractionsScheduled(t: TestConvex<typeof schema>): Promise<unknown[]> {
	return await t.run(async (ctx) =>
		(await ctx.db.system.query('_scheduled_functions').collect())
			.filter((job) => job.name.includes('liveKnowledge'))
			.map((job) => (job.args[0] as { mailMessageId: unknown }).mailMessageId)
	);
}

async function withHeldScheduler(body: () => Promise<void>): Promise<void> {
	vi.useFakeTimers();
	try {
		await body();
	} finally {
		vi.useRealTimers();
	}
}

describe('live mail → knowledge extraction', () => {
	it('forward sync from another person schedules extraction of that message', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		await withHeldScheduler(async () => {
			const messageId = await ingest(t, seeded);
			expect(await extractionsScheduled(t)).toEqual([messageId]);
		});
	});

	it('schedules nothing while ai.knowledge is off', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t, { ai: true });
		await withHeldScheduler(async () => {
			await ingest(t, seeded);
			expect(await extractionsScheduled(t)).toEqual([]);
		});
	});

	it('a historical import (backfill) is left to the import sweep', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		await withHeldScheduler(async () => {
			await ingest(t, seeded, { origin: 'backfill' });
			expect(await extractionsScheduled(t)).toEqual([]);
		});
	});

	it("skips the mailbox's own mail and the Sent folder", async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		await withHeldScheduler(async () => {
			const own = await ingest(t, seeded, { from: `Team <${OWNER_ADDRESS}>` });
			const sent = await ingest(t, seeded, { folderRole: 'sent' });
			expect(own).not.toEqual(sent);
			expect(await extractionsScheduled(t)).toEqual([]);
		});
	});

	it('skips mailing-list and auto-submitted mail', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		await withHeldScheduler(async () => {
			const list = await ingest(t, seeded, {
				antiLoopHeaders: { 'list-id': '<news.customer.test>' },
			});
			const auto = await ingest(t, seeded, {
				antiLoopHeaders: { 'auto-submitted': 'auto-replied' },
			});
			expect(list).not.toEqual(auto);
			expect(await extractionsScheduled(t)).toEqual([]);
		});
	});

	it('extracts a normal message and resolves its sender contact', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		await withHeldScheduler(async () => {
			const messageId = await ingest(t, seeded);
			await t.action(internal.mail.liveKnowledge.extractLiveMessage, { mailMessageId: messageId });
			expect(extracted).toEqual([messageId]);
			expect(await contactEmails(t)).toContain('sam@customer.test');
		});
	});

	it('refuses phishing from a connected mailbox (no verdict) and creates no contact', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		await withHeldScheduler(async () => {
			const messageId = await ingest(t, seeded, PHISHING);
			const row = await t.run(async (ctx) => await ctx.db.get(messageId));
			// The external path leaves delivery alone: still in the inbox, no verdict.
			expect(row?.spamVerdict).toBeUndefined();
			await t.action(internal.mail.liveKnowledge.extractLiveMessage, { mailMessageId: messageId });
			expect(extracted).toEqual([]);
			expect(await contactEmails(t)).not.toContain('support@page-help.example.com');
		});
	});

	it('refuses a clean-looking message whose DMARC failed', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		await withHeldScheduler(async () => {
			const messageId = await ingest(t, seeded);
			await t.run(async (ctx) => await ctx.db.patch(messageId, { dmarcResult: 'fail' }));
			await t.action(internal.mail.liveKnowledge.extractLiveMessage, { mailMessageId: messageId });
			expect(extracted).toEqual([]);
		});
	});
});

async function contactEmails(t: TestConvex<typeof schema>): Promise<string[]> {
	return await t.run(async (ctx) =>
		(await ctx.db.query('contacts').collect()).map((c) => c.email ?? '')
	);
}
