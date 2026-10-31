/**
 * What `mail/delivery.ts:deliverToMailbox` writes and answers on each path:
 * the four ways it skips a message, where the user's filters and the scan
 * verdicts file it, the row fields the filters set, the stored parts, the
 * post-delivery hook it schedules and the answer the ingest action reads.
 *
 * Spam scoring, the ARC rescue and the sender-status filing have their own
 * suites (`delivery.test.ts`, `arcOverride.test.ts`,
 * `senders/__tests__/delivery.integration.test.ts`); this one pins the rest
 * so the handler can be split without moving what it writes.
 */

import type { TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { liveMailTest, seedFolder, seedMailbox } from './helpers.testlib';

type Harness = TestConvex<typeof schema>;

const ADDRESS = 'me@owlat.test';

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

async function seedInbox(t: Harness, overrides: { quotaBytes?: number } = {}) {
	const mailboxId = await seedMailbox(t, { address: ADDRESS });
	if (overrides.quotaBytes !== undefined) {
		await t.run((ctx) => ctx.db.patch(mailboxId, { quotaBytes: overrides.quotaBytes }));
	}
	const inboxId = await seedFolder(t, mailboxId, 'inbox');
	return { mailboxId, inboxId };
}

async function deliver(t: Harness, overrides: Record<string, unknown> = {}) {
	const rawStorageId = await t.run((ctx) => ctx.storage.store(new Blob(['raw'])));
	return t.mutation(internal.mail.delivery.deliverToMailbox, {
		rawStorageId,
		rawSize: 3,
		recipientAddress: `Me <${ADDRESS}>`,
		from: 'News Desk <news@example.com>',
		to: [ADDRESS],
		cc: [],
		bcc: [],
		subject: 'Weekly notes',
		textBodyInline: 'Plain notes for the week.',
		snippet: 'Plain notes',
		messageId: '<weekly-1@example.com>',
		receivedAt: 1_700_000_000_000,
		attachments: [],
		...overrides,
	});
}

async function addFilter(
	t: Harness,
	mailboxId: Id<'mailboxes'>,
	actions: Array<Record<string, unknown>>
) {
	await t.run((ctx) =>
		ctx.db.insert('mailFilters', {
			mailboxId,
			name: 'news',
			isEnabled: true,
			priority: 1,
			conditions: [{ field: 'from', op: 'contains', value: 'news@' }],
			actions: actions as never,
			stopProcessing: false,
			createdAt: 0,
			updatedAt: 0,
		})
	);
}

const messages = (t: Harness) => t.run((ctx) => ctx.db.query('mailMessages').collect());
const hookJobs = (t: Harness) =>
	t.run(async (ctx) =>
		(await ctx.db.system.query('_scheduled_functions').collect()).filter(
			(job) => job.name === 'mail/deliveryHooks:runPostDelivery'
		)
	);

describe('deliverToMailbox: skipped deliveries', () => {
	it('skips mail for an address no mailbox owns', async () => {
		const t = liveMailTest();
		await seedInbox(t);

		expect(await deliver(t, { recipientAddress: 'nobody@owlat.test' })).toEqual({ skipped: true });
		expect(await messages(t)).toHaveLength(0);
	});

	it('skips mail a full mailbox has no room for', async () => {
		const t = liveMailTest();
		await seedInbox(t, { quotaBytes: 2 });

		expect(await deliver(t)).toEqual({ skipped: true });
		expect(await messages(t)).toHaveLength(0);
	});

	it('skips a Message-ID the mailbox already holds', async () => {
		const t = liveMailTest();
		await seedInbox(t);

		expect('messageId' in (await deliver(t))).toBe(true);
		expect(await deliver(t)).toEqual({ skipped: true });
		expect(await messages(t)).toHaveLength(1);
	});

	it('skips a message a filter discards, before anything is written', async () => {
		const t = liveMailTest();
		const { mailboxId } = await seedInbox(t);
		await addFilter(t, mailboxId, [{ type: 'discard' }]);

		expect(await deliver(t)).toEqual({ skipped: true });
		expect(await messages(t)).toHaveLength(0);
		expect(await hookJobs(t)).toHaveLength(0);
	});

	it('skips when the mailbox has no folder to file into', async () => {
		const t = liveMailTest();
		await seedMailbox(t, { address: ADDRESS });

		expect(await deliver(t)).toEqual({ skipped: true });
		expect(await messages(t)).toHaveLength(0);
	});
});

describe('deliverToMailbox: where the message lands', () => {
	it('files plain mail into the inbox and answers with its routing', async () => {
		const t = liveMailTest();
		const { inboxId } = await seedInbox(t);

		const result = await deliver(t);

		const [row] = await messages(t);
		expect(result).toEqual({
			messageId: row?._id,
			dmarcOverride: undefined,
			folderRole: 'inbox',
			spamVerdict: 'ham',
		});
		expect(row).toMatchObject({
			folderId: inboxId,
			flagSeen: false,
			flagFlagged: false,
			labelIds: [],
			subject: 'Weekly notes',
		});
	});

	it("applies a filter's folder, flags, labels and forward target", async () => {
		const t = liveMailTest();
		const { mailboxId } = await seedInbox(t);
		const projectsId = await t.run((ctx) =>
			ctx.db.insert('mailFolders', {
				mailboxId,
				name: 'Projects',
				uidNext: 1,
				uidValidity: 1,
				highestModseq: 1,
				totalCount: 0,
				unseenCount: 0,
				subscribed: true,
				createdAt: 0,
				updatedAt: 0,
			})
		);
		const labelId = await t.run((ctx) =>
			ctx.db.insert('mailLabels', { mailboxId, name: 'News', createdAt: 0 })
		);
		await addFilter(t, mailboxId, [
			{ type: 'moveToFolder', folderId: projectsId },
			{ type: 'markRead' },
			{ type: 'markFlagged' },
			{ type: 'addLabel', labelId },
			{ type: 'forward', forwardTo: 'archive@owlat.example' },
		]);

		const result = await deliver(t, { returnPath: 'bounces@example.com' });

		const [row] = await messages(t);
		// A custom folder has no role, so the answer carries none.
		expect(result).toEqual({ messageId: row?._id, dmarcOverride: undefined, spamVerdict: 'ham' });
		expect(row).toMatchObject({
			folderId: projectsId,
			flagSeen: true,
			flagFlagged: true,
			labelIds: [labelId],
		});
		const [job] = await hookJobs(t);
		expect(job?.args[0]).toEqual({
			mailboxId,
			mailboxAddress: ADDRESS,
			messageId: row?._id,
			fromAddress: 'news@example.com',
			returnPath: 'bounces@example.com',
			triggeringMessageId: '<weekly-1@example.com>',
			subject: 'Weekly notes',
			bodyText: 'Plain notes for the week.',
			headers: {},
			filterForwardTo: ['archive@owlat.example'],
		});
	});

	it('files a message a filter deletes into the trash', async () => {
		const t = liveMailTest();
		const { mailboxId } = await seedInbox(t);
		const trashId = await seedFolder(t, mailboxId, 'trash');
		await addFilter(t, mailboxId, [{ type: 'delete' }]);

		const result = await deliver(t);

		expect((await messages(t))[0]?.folderId).toBe(trashId);
		expect(result).toMatchObject({ folderRole: 'trash' });
	});

	it('quarantines an infected message into spam, past any filter folder', async () => {
		const t = liveMailTest();
		const { mailboxId } = await seedInbox(t);
		const spamId = await seedFolder(t, mailboxId, 'spam');

		const result = await deliver(t, { virusVerdict: 'infected', spamVerdict: 'ham' });

		const [row] = await messages(t);
		expect(row?.folderId).toBe(spamId);
		expect(row?.virusVerdict).toBe('infected');
		expect(result).toEqual({
			messageId: row?._id,
			dmarcOverride: undefined,
			folderRole: 'spam',
			spamVerdict: 'ham',
		});
	});

	it('records the parts the ingest action stored and hands the hook the raw headers', async () => {
		const t = liveMailTest();
		await seedInbox(t);
		const rawStorageId = await t.run((ctx) => ctx.storage.store(new Blob(['raw'])));
		const partId = await t.run((ctx) => ctx.storage.store(new Blob(['pdf'])));
		const storedParts = {
			status: 'stored' as const,
			parts: [{ filename: 'a.pdf', contentType: 'application/pdf', size: 3, storageId: partId }],
		};

		await deliver(t, {
			rawStorageId,
			storedParts,
			antiLoopHeaders: { 'auto-submitted': 'no' },
			references: '<earlier@example.com>',
		});

		const parts = await t.run((ctx) => ctx.db.query('mailMessageParts').collect());
		expect(parts).toEqual([expect.objectContaining({ rawStorageId, ...storedParts })]);
		const [job] = await hookJobs(t);
		expect(job?.args[0]).toMatchObject({
			headers: { 'auto-submitted': 'no' },
			triggeringReferences: '<earlier@example.com>',
			filterForwardTo: [],
		});
	});
});
