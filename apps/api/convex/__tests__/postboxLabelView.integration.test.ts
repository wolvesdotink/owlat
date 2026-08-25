/**
 * mail.mailbox.queries.listByLabel — the server-side label view.
 *
 * Guards the P7 replacement contract: the label page's filtering happens on
 * the SERVER over a bounded indexed scan (Convex has no element-containment
 * index for array fields, so whole-array equality is useless here), only
 * matching rows cross the wire, and the result is scoped to the caller's
 * mailbox. These tests pin: exact membership, newest-first order, limit
 * slicing with an honest hasMore, and no leakage across labels or mailboxes.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		getBetterAuthSessionWithRole: vi.fn().mockResolvedValue({
			userId: 'test-user',
			role: 'owner',
			activeOrganizationId: 'test-org',
		}),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('agentContext') &&
			!path.includes('llmProvider')
	)
);

type Fixture = {
	mailboxId: Id<'mailboxes'>;
	labelA: Id<'mailLabels'>;
	labelB: Id<'mailLabels'>;
	labeledIds: Id<'mailMessages'>[];
};

/** One mailbox, two labels, 7 messages of which 3 carry label A. */
async function seed(t: ReturnType<typeof convexTest>): Promise<Fixture> {
	let fixture!: Fixture;
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
		const inboxId = await ctx.db.insert('mailFolders', {
			mailboxId,
			name: 'INBOX',
			role: 'inbox',
			uidValidity: now,
			uidNext: 1,
			highestModseq: 1,
			totalCount: 0,
			unseenCount: 0,
			subscribed: true,
			createdAt: now,
			updatedAt: now,
		});
		const threadId = await ctx.db.insert('mailThreads', {
			mailboxId,
			normalizedSubject: 'labels',
			participants: ['sara@acme.com'],
			messageCount: 7,
			unreadCount: 0,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: now,
			firstMessageAt: now,
			latestSnippet: 'labeled',
			latestFromAddress: 'sara@acme.com',
			latestSubject: 'labels',
			folderRoles: ['inbox'],
			labelIds: [],
			createdAt: now,
			updatedAt: now,
		});
		const labelA = await ctx.db.insert('mailLabels', {
			mailboxId,
			name: 'work',
			createdAt: now,
		});
		const labelB = await ctx.db.insert('mailLabels', {
			mailboxId,
			name: 'personal',
			createdAt: now,
		});

		const labeledIds: Id<'mailMessages'>[] = [];
		for (let i = 0; i < 7; i++) {
			// Messages 1, 3, 5 (of 0..6) carry label A; message 5 also carries B.
			const labels = i === 5 ? [labelA, labelB] : i % 2 === 1 ? [labelA] : [];
			const storageId = await ctx.storage.store(new Blob([`body-${i}`]));
			const messageId = await ctx.db.insert('mailMessages', {
				mailboxId,
				folderId: inboxId,
				uid: i + 1,
				modseq: i + 1,
				rfc822MessageId: `<m${i}@acme.com>`,
				threadId,
				fromAddress: 'sara@acme.com',
				toAddresses: ['me@example.com'],
				ccAddresses: [],
				bccAddresses: [],
				subject: `message ${i}`,
				normalizedSubject: `message ${i}`,
				snippet: `body ${i}`,
				rawStorageId: storageId,
				rawSize: 6,
				attachments: [],
				hasAttachments: false,
				flagSeen: true,
				flagFlagged: false,
				flagAnswered: false,
				flagDraft: false,
				flagDeleted: false,
				customFlags: [],
				labelIds: labels,
				receivedAt: now + i * 1000,
				internalDate: now,
				createdAt: now,
				updatedAt: now,
			});
			if (labels.includes(labelA)) labeledIds.push(messageId);
		}
		fixture = { mailboxId, labelA, labelB, labeledIds };
	});
	return fixture;
}

describe('mail.mailbox.queries.listByLabel', () => {
	it('returns exactly the messages carrying the label, newest first', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, labelA, labeledIds } = await seed(t);

		const result = await t.query(api.mail.mailbox.queries.listByLabel, {
			mailboxId,
			labelId: labelA,
		});
		expect(result.messages.map((m) => m._id)).toEqual([...labeledIds].reverse());
		expect(result.hasMore).toBe(false);
		expect(result.nextCursor).toBeNull();
	});

	it('slices by limit and reports hasMore honestly', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, labelA, labeledIds } = await seed(t);

		const page = await t.query(api.mail.mailbox.queries.listByLabel, {
			mailboxId,
			labelId: labelA,
			limit: 2,
		});
		expect(page.messages.map((m) => m._id)).toEqual([...labeledIds].reverse().slice(0, 2));
		expect(page.hasMore).toBe(true);
	});

	it("does not leak another label's messages through a shared message", async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, labelB } = await seed(t);
		// Message 5 carries both A and B; querying B returns only that one.
		const result = await t.query(api.mail.mailbox.queries.listByLabel, {
			mailboxId,
			labelId: labelB,
		});
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0]!.subject).toBe('message 5');
	});

	it('hides still-snoozed rows like every other folder view', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, labelA } = await seed(t);
		await t.run(async (ctx) => {
			// Snooze the newest labeled message ("message 5").
			const scanned = await ctx.db
				.query('mailMessages')
				.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', mailboxId))
				.order('desc')
				.take(50);
			const target = scanned.find((m) => m.subject === 'message 5')!;
			await ctx.db.patch(target._id, { snoozedUntil: Date.now() + 60_000 });
		});
		const result = await t.query(api.mail.mailbox.queries.listByLabel, {
			mailboxId,
			labelId: labelA,
		});
		expect(result.messages.map((m) => m.subject)).toEqual(['message 3', 'message 1']);
	});

	it('snoozed rows do not eat result slots or inflate hasMore', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, labelA } = await seed(t);
		await t.run(async (ctx) => {
			const scanned = await ctx.db
				.query('mailMessages')
				.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', mailboxId))
				.order('desc')
				.take(50);
			const target = scanned.find((m) => m.subject === 'message 5')!;
			await ctx.db.patch(target._id, { snoozedUntil: Date.now() + 60_000 });
		});

		// Three rows carry label A; the newest is snoozed. Asking for 2 must
		// return the two VISIBLE rows — slicing before the snooze filter handed
		// back a short page (one row) with matches still inside the window.
		const page = await t.query(api.mail.mailbox.queries.listByLabel, {
			mailboxId,
			labelId: labelA,
			limit: 2,
		});
		expect(page.messages.map((m) => m.subject)).toEqual(['message 3', 'message 1']);
		// Two visible matches, two returned: nothing is being withheld, so the
		// cap note must not claim otherwise (the pre-filter count said it was).
		expect(page.hasMore).toBe(false);
	});

	it('rows older than the scan window are out of reach — the documented edge', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, labelA } = await seed(t);
		// Push the mailbox past LABEL_SCAN_WINDOW (1000): 993 unlabeled fillers
		// newer than the fixture's 7 rows, then one LABELED row older than all
		// of them — position 1002, outside the window (while the fixture's
		// labeled rows sit at positions ≤ 1000, inside it).
		await t.run(async (ctx) => {
			const now = Date.now();
			const inboxId = (await ctx.db
				.query('mailFolders')
				.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', mailboxId).eq('role', 'inbox'))
				.first())!._id;
			const threadId = (await ctx.db
				.query('mailThreads')
				.withIndex('by_mailbox_and_last_message', (q) => q.eq('mailboxId', mailboxId))
				.first())!._id;
			for (let i = 7; i < 1000; i++) {
				const storageId = await ctx.storage.store(new Blob([`filler-${i}`]));
				await ctx.db.insert('mailMessages', {
					mailboxId,
					folderId: inboxId,
					uid: i + 1,
					modseq: i + 1,
					rfc822MessageId: `<filler${i}@acme.com>`,
					threadId,
					fromAddress: 'sara@acme.com',
					toAddresses: ['me@example.com'],
					ccAddresses: [],
					bccAddresses: [],
					subject: `filler ${i}`,
					normalizedSubject: `filler ${i}`,
					snippet: `body ${i}`,
					rawStorageId: storageId,
					rawSize: 8,
					attachments: [],
					hasAttachments: false,
					flagSeen: true,
					flagFlagged: false,
					flagAnswered: false,
					flagDraft: false,
					flagDeleted: false,
					customFlags: [],
					labelIds: [],
					receivedAt: now + i * 1000,
					internalDate: now,
					createdAt: now,
					updatedAt: now,
				});
			}
			const deepStorageId = await ctx.storage.store(new Blob(['deep']));
			await ctx.db.insert('mailMessages', {
				mailboxId,
				folderId: inboxId,
				uid: 2000,
				modseq: 2000,
				rfc822MessageId: '<deep@acme.com>',
				threadId,
				fromAddress: 'sara@acme.com',
				toAddresses: ['me@example.com'],
				ccAddresses: [],
				bccAddresses: [],
				subject: 'deep labeled',
				normalizedSubject: 'deep labeled',
				snippet: 'deep body',
				rawStorageId: deepStorageId,
				rawSize: 9,
				attachments: [],
				hasAttachments: false,
				flagSeen: true,
				flagFlagged: false,
				flagAnswered: false,
				flagDraft: false,
				flagDeleted: false,
				customFlags: [],
				labelIds: [labelA],
				receivedAt: now - 10_000,
				internalDate: now,
				createdAt: now,
				updatedAt: now,
			});
		});

		const result = await t.query(api.mail.mailbox.queries.listByLabel, {
			mailboxId,
			labelId: labelA,
		});
		// The three windowed labeled rows are served newest-first; the labeled
		// row beyond the scan window is invisible — LABEL_SCAN_WINDOW is the
		// view's documented total reach until membership gets a real index.
		expect(result.messages.map((m) => m.subject)).toEqual(['message 5', 'message 3', 'message 1']);
		expect(result.hasMore).toBe(false);
	});
});
