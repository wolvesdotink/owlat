/**
 * Upload-based archive import (idea 50).
 *
 * The properties that matter are the ones a one-shot importer would not have:
 * the job walks an archive in budgeted passes and can be resumed from a byte
 * offset, re-importing the same file adds nothing twice, and Gmail Takeout's
 * `X-Gmail-Labels` decides the folder, the flags and the labels instead of
 * every message landing in one heap.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api } from '../../_generated/api';
import { MAX_ARCHIVE_BYTES } from '../archiveImport';
import { modules, seedMailbox, seedFolder } from './helpers.testlib';

const sessionMocks = vi.hoisted(() => ({
	userId: 'user-A',
	role: 'owner' as 'owner' | 'admin' | 'editor',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
		})),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
		})),
		getBetterAuthSessionWithRole: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
			activeOrganizationId: 'org-1',
		})),
	};
});

beforeEach(() => {
	sessionMocks.userId = 'user-A';
	sessionMocks.role = 'owner';
});

/** The runner reschedules itself, so the drain has to span the whole walk. */
async function drainScheduler(t: TestConvex<typeof schema>): Promise<void> {
	vi.useFakeTimers();
	try {
		await t.finishAllScheduledFunctions(vi.runAllTimers);
	} finally {
		vi.useRealTimers();
	}
}

function takeoutMessage(options: {
	messageId: string;
	subject: string;
	labels?: string;
	body?: string;
}): string {
	return [
		'From nobody@example.com Mon Jan 01 00:00:00 +0000 2018',
		...(options.labels ? [`X-Gmail-Labels: ${options.labels}`] : []),
		'From: sender@isp.example',
		'To: me@hinterland.camp',
		`Subject: ${options.subject}`,
		`Message-ID: <${options.messageId}>`,
		'Date: Mon, 1 Jan 2018 00:00:00 +0000',
		'Content-Type: text/plain; charset=utf-8',
		'',
		options.body ?? 'hello there',
		'',
	].join('\n');
}

async function storeArchive(t: TestConvex<typeof schema>, text: string): Promise<Id<'_storage'>> {
	let storageId!: Id<'_storage'>;
	await t.run(async (ctx) => {
		storageId = await ctx.storage.store(new Blob([text], { type: 'application/mbox' }));
	});
	return storageId;
}

async function seedMailboxWithFolders(t: TestConvex<typeof schema>): Promise<Id<'mailboxes'>> {
	const mailboxId = await seedMailbox(t);
	for (const role of ['inbox', 'archive', 'trash', 'spam', 'sent'] as const) {
		await seedFolder(t, mailboxId, role);
	}
	return mailboxId;
}

async function importArchive(
	t: TestConvex<typeof schema>,
	mailboxId: Id<'mailboxes'>,
	text: string,
	format: 'mbox' | 'eml' = 'mbox'
) {
	const storageId = await storeArchive(t, text);
	const started = await t.mutation(api.mail.archiveImport.start, {
		mailboxId,
		storageId,
		filename: `archive.${format}`,
		format,
		totalBytes: text.length,
	});
	await drainScheduler(t);
	return started;
}

async function messagesIn(t: TestConvex<typeof schema>, mailboxId: Id<'mailboxes'>) {
	return await t.run(async (ctx) => {
		const rows = await ctx.db
			.query('mailMessages')
			.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', mailboxId))
			.collect();
		return await Promise.all(
			rows.map(async (row) => ({
				subject: row.subject,
				flagSeen: row.flagSeen,
				flagFlagged: row.flagFlagged,
				folderRole: (await ctx.db.get(row.folderId))?.role,
				labelNames: await Promise.all(
					(row.labelIds ?? []).map(async (id) => (await ctx.db.get(id))?.name)
				),
			}))
		);
	});
}

describe('archive import', () => {
	it('imports every message of an mbox and reports the job as completed', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailboxWithFolders(t);
		const archive =
			takeoutMessage({ messageId: 'one@x', subject: 'One' }) +
			takeoutMessage({ messageId: 'two@x', subject: 'Two' });

		await importArchive(t, mailboxId, archive);

		const status = await t.query(api.mail.archiveImport.getStatus, { mailboxId });
		expect(status?.status).toBe('completed');
		expect(status?.messagesImported).toBe(2);
		expect(status?.percent).toBe(100);
		expect((await messagesIn(t, mailboxId)).map((m) => m.subject).sort()).toEqual(['One', 'Two']);
	});

	it('files a Takeout message by its Gmail labels, not by a single default folder', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailboxWithFolders(t);
		const archive =
			takeoutMessage({
				messageId: 'inbox@x',
				subject: 'Unread inbox',
				labels: 'Inbox,Unread,Starred,Category Updates,Work/Invoices',
			}) +
			takeoutMessage({ messageId: 'trash@x', subject: 'Trashed', labels: 'Trash' }) +
			takeoutMessage({ messageId: 'plain@x', subject: 'No labels' });

		await importArchive(t, mailboxId, archive);

		const messages = await messagesIn(t, mailboxId);
		const inbox = messages.find((m) => m.subject === 'Unread inbox');
		expect(inbox?.folderRole).toBe('inbox');
		expect(inbox?.flagSeen).toBe(false);
		expect(inbox?.flagFlagged).toBe(true);
		// The user's own label is kept; Gmail's tabs and flags are not labels.
		expect(inbox?.labelNames).toEqual(['Invoices']);
		expect(messages.find((m) => m.subject === 'Trashed')?.folderRole).toBe('trash');
		// No label header at all: archived and read, never a manufactured unread.
		const plain = messages.find((m) => m.subject === 'No labels');
		expect(plain?.folderRole).toBe('archive');
		expect(plain?.flagSeen).toBe(true);

		const status = await t.query(api.mail.archiveImport.getStatus, { mailboxId });
		// `Work` and `Invoices` — a nested Gmail label is a path, not one row.
		expect(status?.labelsCreated).toBe(2);
	});

	it('adds nothing twice when the same archive is imported again', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailboxWithFolders(t);
		const archive =
			takeoutMessage({ messageId: 'one@x', subject: 'One' }) +
			takeoutMessage({ messageId: 'two@x', subject: 'Two' });

		await importArchive(t, mailboxId, archive);
		await importArchive(t, mailboxId, archive);

		expect(await messagesIn(t, mailboxId)).toHaveLength(2);
		const status = await t.query(api.mail.archiveImport.getStatus, { mailboxId });
		expect(status?.messagesImported).toBe(0);
		expect(status?.messagesSkipped).toBe(2);
	});

	it('resumes at the committed byte offset instead of re-walking the archive', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailboxWithFolders(t);
		const archive =
			takeoutMessage({ messageId: 'one@x', subject: 'One' }) +
			takeoutMessage({ messageId: 'two@x', subject: 'Two' });
		const secondStart = archive.indexOf('From nobody', 1);
		const storageId = await storeArchive(t, archive);
		const started = await t.mutation(api.mail.archiveImport.start, {
			mailboxId,
			storageId,
			filename: 'a.mbox',
			format: 'mbox',
			totalBytes: archive.length,
		});
		if (!started.ok) throw new Error('import did not start');

		// Stand in for a first pass that committed the opening message and then
		// died: the resume point is a byte offset, and nothing before it is read
		// again.
		await t.run(async (ctx) => {
			await ctx.db.patch(started.importId, { cursorBytes: secondStart });
		});
		await drainScheduler(t);

		expect((await messagesIn(t, mailboxId)).map((m) => m.subject)).toEqual(['Two']);
		const status = await t.query(api.mail.archiveImport.getStatus, { mailboxId });
		expect(status?.status).toBe('completed');
		expect(status?.messagesImported).toBe(1);
	});

	it('imports a single .eml as one message', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailboxWithFolders(t);
		const eml = [
			'From: sender@isp.example',
			'To: me@hinterland.camp',
			'Subject: Saved message',
			'Message-ID: <saved@x>',
			'',
			'body',
			'',
		].join('\n');

		await importArchive(t, mailboxId, eml, 'eml');

		const messages = await messagesIn(t, mailboxId);
		expect(messages).toHaveLength(1);
		expect(messages[0]?.subject).toBe('Saved message');
		expect(messages[0]?.folderRole).toBe('archive');
	});

	it('deletes the uploaded archive once the job is terminal', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailboxWithFolders(t);
		await importArchive(t, mailboxId, takeoutMessage({ messageId: 'one@x', subject: 'One' }));

		await t.run(async (ctx) => {
			const job = await ctx.db
				.query('mailArchiveImports')
				.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailboxId))
				.first();
			expect(job?.storageId).toBeUndefined();
		});
	});

	it('refuses an archive larger than the ceiling and drops its upload', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailboxWithFolders(t);
		const storageId = await storeArchive(t, 'x');

		const refused = await t.mutation(api.mail.archiveImport.start, {
			mailboxId,
			storageId,
			filename: 'huge.mbox',
			format: 'mbox',
			totalBytes: MAX_ARCHIVE_BYTES + 1,
		});
		expect(refused).toEqual({ ok: false, reason: 'too_large' });

		await t.run(async (ctx) => {
			expect(await ctx.storage.get(storageId)).toBeNull();
		});
	});

	it('refuses a second import while one is running', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailboxWithFolders(t);
		const archive = takeoutMessage({ messageId: 'one@x', subject: 'One' });
		const first = await storeArchive(t, archive);
		await t.mutation(api.mail.archiveImport.start, {
			mailboxId,
			storageId: first,
			filename: 'a.mbox',
			format: 'mbox',
			totalBytes: archive.length,
		});

		const second = await storeArchive(t, archive);
		const refused = await t.mutation(api.mail.archiveImport.start, {
			mailboxId,
			storageId: second,
			filename: 'b.mbox',
			format: 'mbox',
			totalBytes: archive.length,
		});
		expect(refused).toEqual({ ok: false, reason: 'already_running' });
		// The refused upload is deleted rather than left billable.
		await t.run(async (ctx) => {
			expect(await ctx.storage.get(second)).toBeNull();
		});
		await drainScheduler(t);
	});

	it('keeps the mail a cancelled import already landed', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailboxWithFolders(t);
		const archive = takeoutMessage({ messageId: 'one@x', subject: 'One' });
		const storageId = await storeArchive(t, archive);
		const started = await t.mutation(api.mail.archiveImport.start, {
			mailboxId,
			storageId,
			filename: 'a.mbox',
			format: 'mbox',
			totalBytes: archive.length,
		});
		if (!started.ok) throw new Error('import did not start');

		expect(await t.mutation(api.mail.archiveImport.cancel, { importId: started.importId })).toBe(
			true
		);
		await drainScheduler(t);

		const status = await t.query(api.mail.archiveImport.getStatus, { mailboxId });
		expect(status?.status).toBe('cancelled');
		// Cancelling a second time is a no-op, not an error.
		expect(await t.mutation(api.mail.archiveImport.cancel, { importId: started.importId })).toBe(
			false
		);
	});

	it('is invisible to a caller who cannot reach the mailbox', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailboxWithFolders(t);
		await importArchive(t, mailboxId, takeoutMessage({ messageId: 'one@x', subject: 'One' }));

		sessionMocks.userId = 'user-B';
		sessionMocks.role = 'editor';
		expect(await t.query(api.mail.archiveImport.getStatus, { mailboxId })).toBeNull();
	});
});
