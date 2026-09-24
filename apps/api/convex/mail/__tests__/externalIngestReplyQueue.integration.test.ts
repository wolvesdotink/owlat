/**
 * The IMAP-sync ingest path feeding the Reply Queue — `origin` is the gate.
 *
 * `mail/external/delivery.ts::ingestExternalMessage` lands every message the
 * mail-sync worker fetches. Forward sync ('sync') into the INBOX is the only
 * shape allowed to fan out background LLM work: it marks the thread pending and
 * schedules `needsReplyClassify.classifyThread` + `categoryClassify.classifyThread`,
 * exactly like the hosted webhook path (mail/delivery.ts). Everything else —
 * a historical import ('backfill'), a worker one release behind that sends no
 * origin at all, a non-inbox folder, or a MUTED thread whose delivery was
 * re-routed into Archive inside the insert — must schedule nothing.
 *
 * The last case also covers the anti-loop headers: `ingestExternalRaw` parses
 * `Precedence:` out of the raw message and hands it down, so bulk mail reaches
 * the classifiers already flagged (the header is never persisted on the row).
 *
 * The final block drives that ACTION itself — raw bytes in, `origin` and the
 * parsed Precedence out — so the worker-facing plumbing is pinned too, not just
 * the mutation it delegates to.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { internal } from '../../_generated/api';
import { modules } from './helpers.testlib';
import { extractAntiLoopHeaders } from '../../lib/inboundClassification';

const OWNER_ADDRESS = 'me@gmail.example';
const SENDER = 'sam@acme.test';

type Seeded = {
	accountId: Id<'externalMailAccounts'>;
	mailboxId: Id<'mailboxes'>;
	inboxId: Id<'mailFolders'>;
	archiveId: Id<'mailFolders'>;
};

/** An external (IMAP-synced) mailbox with its account row and system folders. */
async function seedExternalAccount(
	t: TestConvex<typeof schema>,
	opts: { scope?: 'shared' } = {}
): Promise<Seeded> {
	let out!: Seeded;
	await t.run(async (ctx) => {
		const now = Date.now();
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'user-A',
			organizationId: 'org-1',
			address: OWNER_ADDRESS,
			domain: 'gmail.example',
			kind: 'external',
			...(opts.scope ? { scope: opts.scope } : {}),
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		const folder = async (role: 'inbox' | 'archive' | 'sent') =>
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
		const inboxId = await folder('inbox');
		const archiveId = await folder('archive');
		await folder('sent');
		const accountId = await ctx.db.insert('externalMailAccounts', {
			userId: 'user-A',
			organizationId: 'org-1',
			mailboxId,
			...(opts.scope ? { scope: opts.scope } : {}),
			imapHost: 'imap.gmail.example',
			imapPort: 993,
			isImapSecure: true,
			smtpHost: 'smtp.gmail.example',
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
		out = { accountId, mailboxId, inboxId, archiveId };
	});
	return out;
}

/** Drive one ingest through the mutation the worker's action delegates to. */
async function ingest(
	t: TestConvex<typeof schema>,
	seeded: Seeded,
	opts: {
		origin?: 'sync' | 'backfill';
		folderRole?: 'inbox' | 'sent';
		subject?: string;
		uid?: number;
		from?: string;
		to?: string;
		receivedAt?: number;
		antiLoopHeaders?: Record<string, string>;
	} = {}
): Promise<void> {
	const rawStorageId = await t.run(async (ctx) => await ctx.storage.store(new Blob(['raw'])));
	await t.mutation(internal.mail.external.delivery.ingestExternalMessage, {
		accountId: seeded.accountId,
		folderRole: opts.folderRole ?? 'inbox',
		remoteName: opts.folderRole === 'sent' ? 'Sent' : 'INBOX',
		remoteUid: opts.uid ?? 42,
		remoteUidValidity: 7,
		rawStorageId,
		rawSize: 3,
		from: opts.from ?? `Sam <${SENDER}>`,
		to: [opts.to ?? OWNER_ADDRESS],
		cc: [],
		bcc: [],
		subject: opts.subject ?? 'Friday plans?',
		textBodyInline: 'Can you confirm Friday works?',
		messageId: `<m${opts.uid ?? 42}@acme.test>`,
		receivedAt: opts.receivedAt ?? Date.now(),
		attachments: [],
		...(opts.origin ? { origin: opts.origin } : {}),
		...(opts.antiLoopHeaders ? { antiLoopHeaders: opts.antiLoopHeaders } : {}),
	});
}

/** Every pending scheduled job, as `{ name, args }`. */
async function scheduled(
	t: TestConvex<typeof schema>
): Promise<Array<{ name: string; args: Record<string, unknown> }>> {
	return await t.run(async (ctx) =>
		(await ctx.db.system.query('_scheduled_functions').collect()).map((job) => ({
			name: job.name,
			args: (job.args[0] ?? {}) as Record<string, unknown>,
		}))
	);
}

/** `needsReplyPendingAt` on the thread the ingest landed in (`null` = unset). */
async function pendingAt(
	t: TestConvex<typeof schema>,
	mailboxId: Id<'mailboxes'>
): Promise<number | null> {
	return await t.run(async (ctx) => {
		const thread = await ctx.db
			.query('mailThreads')
			.withIndex('by_mailbox_and_last_message', (q) => q.eq('mailboxId', mailboxId))
			.first();
		return thread?.needsReplyPendingAt ?? null;
	});
}

/** The scheduled jobs are inspected, never executed — no LLM seam needed. */
async function withHeldScheduler(body: () => Promise<void>): Promise<void> {
	vi.useFakeTimers();
	try {
		await body();
	} finally {
		vi.useRealTimers();
	}
}

describe('external IMAP ingest → Reply Queue enqueue', () => {
	it('forward sync into the inbox marks the thread pending and schedules both classifiers', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seedExternalAccount(t);

		await withHeldScheduler(async () => {
			await ingest(t, seeded, { origin: 'sync' });

			expect(await pendingAt(t, seeded.mailboxId)).toEqual(expect.any(Number));
			const names = (await scheduled(t)).map((job) => job.name);
			expect(names).toEqual(
				expect.arrayContaining([
					expect.stringContaining('needsReplyClassify'),
					expect.stringContaining('categoryClassify'),
				])
			);
		});
	});

	it('a historical import (backfill) schedules nothing', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seedExternalAccount(t);

		await withHeldScheduler(async () => {
			await ingest(t, seeded, { origin: 'backfill' });

			expect(await pendingAt(t, seeded.mailboxId)).toBeNull();
			expect(await scheduled(t)).toEqual([]);
		});
	});

	it('an older worker that sends no origin at all schedules nothing (fails safe)', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seedExternalAccount(t);

		await withHeldScheduler(async () => {
			await ingest(t, seeded, {});

			expect(await pendingAt(t, seeded.mailboxId)).toBeNull();
			expect(await scheduled(t)).toEqual([]);
		});
	});

	it('forward sync into a NON-inbox folder (Sent) schedules nothing', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seedExternalAccount(t);

		await withHeldScheduler(async () => {
			await ingest(t, seeded, { origin: 'sync', folderRole: 'sent' });

			expect(await scheduled(t)).toEqual([]);
		});
	});

	it('a MUTED thread whose delivery is re-routed to Archive schedules nothing', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seedExternalAccount(t);
		// The insert threads the reply by subject window (same correspondent, Re:
		// prefix), then mail/mute.ts re-routes the delivery into Archive — so the
		// row's ACTUAL folder is not the inbox.
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('mailThreads', {
				mailboxId: seeded.mailboxId,
				normalizedSubject: 'friday plans?',
				participants: [SENDER],
				messageCount: 1,
				unreadCount: 0,
				hasFlagged: false,
				hasAttachments: false,
				lastMessageAt: now,
				firstMessageAt: now,
				latestSnippet: 'earlier',
				latestFromAddress: SENDER,
				latestSubject: 'Friday plans?',
				folderRoles: ['inbox'],
				labelIds: [],
				mutedAt: now,
				createdAt: now,
				updatedAt: now,
			});
		});

		await withHeldScheduler(async () => {
			await ingest(t, seeded, { origin: 'sync', subject: 'Re: Friday plans?' });

			// Landed in Archive, not the inbox it was addressed to.
			const folderId = await t.run(async (ctx) => {
				const message = await ctx.db
					.query('mailMessages')
					.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', seeded.mailboxId))
					.first();
				return message?.folderId;
			});
			expect(folderId).toBe(seeded.archiveId);
			expect(await pendingAt(t, seeded.mailboxId)).toBeNull();
			expect(await scheduled(t)).toEqual([]);
		});
	});

	it('a Precedence: bulk header reaches both classifiers as their precedence arg', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seedExternalAccount(t);

		await withHeldScheduler(async () => {
			await ingest(t, seeded, {
				origin: 'sync',
				antiLoopHeaders: { precedence: 'bulk' },
			});

			const jobs = await scheduled(t);
			expect(jobs).toHaveLength(2);
			for (const job of jobs) {
				expect(job.args['precedence']).toBe('bulk');
			}
		});
	});
});

describe('external IMAP ingest → owner reply settles the Reply Queue', () => {
	/** Flag the only thread as needing a reply to its first inbound message. */
	async function flagThread(t: TestConvex<typeof schema>, mailboxId: Id<'mailboxes'>) {
		await t.run(async (ctx) => {
			const message = await ctx.db
				.query('mailMessages')
				.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', mailboxId))
				.first();
			if (!message) throw new Error('no message');
			await ctx.db.patch(message.threadId, {
				needsReply: {
					messageId: message._id,
					source: 'heuristic',
					urgency: 'normal',
					detectedAt: Date.now(),
					draftSlot: { draft: 'Sure, Friday works.', confidence: 0.7, generatedAt: Date.now() },
				},
			});
		});
	}

	async function flagOf(t: TestConvex<typeof schema>, mailboxId: Id<'mailboxes'>) {
		return await t.run(async (ctx) => {
			const threads = await ctx.db
				.query('mailThreads')
				.withIndex('by_mailbox_and_last_message', (q) => q.eq('mailboxId', mailboxId))
				.collect();
			expect(threads).toHaveLength(1);
			return threads[0]?.needsReply ?? null;
		});
	}

	it('a reply the owner sent from the provider client clears the flag and its draft', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seedExternalAccount(t);
		const now = Date.now();

		await withHeldScheduler(async () => {
			await ingest(t, seeded, { origin: 'sync', receivedAt: now - 60_000 });
			await flagThread(t, seeded.mailboxId);

			await ingest(t, seeded, {
				origin: 'sync',
				folderRole: 'sent',
				uid: 43,
				from: OWNER_ADDRESS,
				to: SENDER,
				subject: 'Re: Friday plans?',
				receivedAt: now,
			});

			expect(await flagOf(t, seeded.mailboxId)).toBeNull();
		});
	});

	it('an OLDER Sent copy arriving out of order leaves the flag alone', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seedExternalAccount(t);
		const now = Date.now();

		await withHeldScheduler(async () => {
			await ingest(t, seeded, { origin: 'sync', receivedAt: now });
			await flagThread(t, seeded.mailboxId);

			await ingest(t, seeded, {
				origin: 'sync',
				folderRole: 'sent',
				uid: 43,
				from: OWNER_ADDRESS,
				to: SENDER,
				subject: 'Re: Friday plans?',
				receivedAt: now - 60_000,
			});

			expect(await flagOf(t, seeded.mailboxId)).toMatchObject({ source: 'heuristic' });
		});
	});
});

describe('ingestExternalRaw header extraction', () => {
	// The action parses the anti-loop headers out of the same 64 KB header string
	// it already decodes for List-Unsubscribe, and forwards them to the mutation
	// asserted above. Pinned here on the pure extractor the action calls, since
	// `Precedence:` is never persisted on the message row.
	it('pulls Precedence out of a raw RFC 822 message', () => {
		const raw = [
			`From: Sam <${SENDER}>`,
			`To: ${OWNER_ADDRESS}`,
			'Subject: Weekly digest',
			'Precedence: bulk',
			'List-Id: <news.acme.test>',
			'',
			'Body.',
		].join('\r\n');

		expect(extractAntiLoopHeaders(raw)).toEqual({
			precedence: 'bulk',
			'list-id': '<news.acme.test>',
		});
	});
});

/**
 * The same gate one level up, through the REAL action the worker calls.
 *
 * `ingestExternalRaw` is where `origin` is forwarded and where `Precedence:` is
 * parsed out of the raw bytes — the cases above hand the mutation both by hand,
 * so nothing covered the action's own plumbing. These drive it end to end: raw
 * base64 in, sealed blob staged into convex-test's `ctx.storage`, mutation run.
 */
describe('ingestExternalRaw → Reply Queue enqueue', () => {
	/** A minimal RFC 5322 message carrying the bulk-mail marker. */
	function rawBulkMessage(): string {
		const raw = [
			`From: Sam <${SENDER}>`,
			`To: ${OWNER_ADDRESS}`,
			'Subject: Weekly digest',
			'Date: Tue, 6 May 2025 10:00:00 +0000',
			'Message-ID: <digest-1@acme.test>',
			'Precedence: bulk',
			'MIME-Version: 1.0',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'Can you confirm Friday works?',
			'',
		].join('\r\n');
		return Buffer.from(raw, 'utf-8').toString('base64');
	}

	/** Run the worker-facing action for one message. */
	async function ingestRaw(
		t: TestConvex<typeof schema>,
		seeded: Seeded,
		origin: 'sync' | 'backfill'
	): Promise<void> {
		// The raw `.eml` is uploaded out of band (`/mail-sync/raw-message`); the
		// action only ever sees the storage id it produced.
		const rawStorageId = await t.run(async (ctx) =>
			ctx.storage.store(new Blob([Buffer.from(rawBulkMessage(), 'base64')]))
		);
		await t.action(internal.mail.external.delivery.ingestExternalRaw, {
			accountId: seeded.accountId,
			folderRole: 'inbox',
			remoteName: 'INBOX',
			remoteUid: 42,
			remoteUidValidity: 7,
			rawStorageId,
			rawSize: Buffer.from(rawBulkMessage(), 'base64').byteLength,
			headerBlockBase64: rawBulkMessage(),
			from: `Sam <${SENDER}>`,
			to: [OWNER_ADDRESS],
			cc: [],
			bcc: [],
			subject: 'Weekly digest',
			textBodyInline: 'Can you confirm Friday works?',
			messageId: '<digest-1@acme.test>',
			receivedAt: Date.now(),
			attachments: [],
			origin,
		});
	}

	it("forwards origin 'sync' and the parsed Precedence to both classifiers", async () => {
		const t = convexTest(schema, modules);
		const seeded = await seedExternalAccount(t);

		await withHeldScheduler(async () => {
			await ingestRaw(t, seeded, 'sync');

			expect(await pendingAt(t, seeded.mailboxId)).toEqual(expect.any(Number));
			const jobs = await scheduled(t);
			expect(jobs.map((job) => job.name)).toEqual(
				expect.arrayContaining([
					expect.stringContaining('needsReplyClassify'),
					expect.stringContaining('categoryClassify'),
				])
			);
			expect(jobs).toHaveLength(2);
			for (const job of jobs) {
				expect(job.args['precedence']).toBe('bulk');
			}
		});
	});

	it("forwards origin 'backfill', which schedules nothing", async () => {
		const t = convexTest(schema, modules);
		const seeded = await seedExternalAccount(t);

		await withHeldScheduler(async () => {
			await ingestRaw(t, seeded, 'backfill');

			expect(await pendingAt(t, seeded.mailboxId)).toBeNull();
			expect(await scheduled(t)).toEqual([]);
		});
	});
});
