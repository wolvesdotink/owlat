/**
 * The `mailAttachments` junction (idea 37) — the index itself, the resumable
 * backfill over existing mail, the Files-view read, and the `filename:` search
 * branch that now runs off the index instead of a post-filter.
 *
 * The interesting properties are the ones an array-on-the-row could not have:
 * a file is findable past the first page of arrival order, inline parts never
 * enter the index, and a deleted message takes its rows with it.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api } from '../../_generated/api';
import { attachmentKind, isInlineAttachment } from '../attachmentIndex';
import { modules, seedMailbox, seedFolder, seedMessage } from './helpers.testlib';

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

/**
 * Drain the self-rescheduling backfill. `finishAllScheduledFunctions` needs the
 * timer APIs mocked, and the walk reschedules itself, so the fake clock has to
 * span the whole drain rather than a single hop.
 */
async function drainScheduler(t: TestConvex<typeof schema>): Promise<void> {
	vi.useFakeTimers();
	try {
		await t.finishAllScheduledFunctions(vi.runAllTimers);
	} finally {
		vi.useRealTimers();
	}
}

function pdf(filename: string, partIndex = '0') {
	return { filename, contentType: 'application/pdf', size: 1024, partIndex };
}

async function countIndexed(
	t: TestConvex<typeof schema>,
	mailboxId: Id<'mailboxes'>
): Promise<number> {
	let n = 0;
	await t.run(async (ctx) => {
		const rows = await ctx.db
			.query('mailAttachments')
			.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', mailboxId))
			.collect();
		n = rows.length;
	});
	return n;
}

describe('attachmentKind', () => {
	it('buckets the facet vocabulary, parameters and casing included', () => {
		expect(attachmentKind('application/pdf')).toBe('pdf');
		expect(attachmentKind('IMAGE/PNG')).toBe('image');
		expect(attachmentKind('text/csv; charset=utf-8')).toBe('document');
		expect(attachmentKind('application/zip')).toBe('archive');
		expect(attachmentKind('application/x-thing')).toBe('other');
	});
});

describe('isInlineAttachment', () => {
	it('treats a Content-ID part as inline chrome, not a file', () => {
		expect(isInlineAttachment({ ...pdf('logo.png'), contentId: 'logo@sig' })).toBe(true);
		expect(isInlineAttachment(pdf('contract.pdf'))).toBe(false);
	});
});

describe('mail.attachmentBackfill', () => {
	it('indexes existing mail, skips inline parts, and is idempotent on re-run', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		await seedMessage(t, mailboxId, {
			subject: 'contract',
			attachments: [pdf('contract-v4.pdf'), { ...pdf('logo.png', '1'), contentId: 'logo@sig' }],
		});
		await seedMessage(t, mailboxId, { subject: 'no files' });

		// Nothing is indexed until the walk runs: these rows predate the index.
		expect(await countIndexed(t, mailboxId)).toBe(0);

		await t.mutation(api.mail.attachmentBackfill.start, { mailboxId });
		await drainScheduler(t);

		// One row: the inline logo is chrome, not a file anybody went looking for.
		expect(await countIndexed(t, mailboxId)).toBe(1);
		const job = await t.query(api.mail.attachmentBackfill.status, { mailboxId });
		expect(job?.status).toBe('completed');
		expect(job?.indexedCount).toBe(1);
		expect(job?.scannedCount).toBe(2);

		// A second walk must not double the file.
		await t.mutation(api.mail.attachmentBackfill.start, { mailboxId });
		await drainScheduler(t);
		expect(await countIndexed(t, mailboxId)).toBe(1);
	});

	it('refuses a non-owner', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'user-A' });
		sessionMocks.userId = 'user-B';
		sessionMocks.role = 'editor';
		await expect(t.mutation(api.mail.attachmentBackfill.start, { mailboxId })).rejects.toThrow();
		expect(await t.query(api.mail.attachmentBackfill.status, { mailboxId })).toBeNull();
	});
});

describe('mail.mailbox.attachments.list', () => {
	it('lists newest-first and faceted by kind, sender and date', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		const base = 1_700_000_000_000;
		await seedMessage(t, mailboxId, {
			subject: 'contract',
			fromAddress: 'ines@brightpath.example',
			receivedAt: base,
			attachments: [pdf('contract-v4.pdf')],
		});
		await seedMessage(t, mailboxId, {
			subject: 'banner',
			fromAddress: 'mei@example.com',
			receivedAt: base + 1000,
			attachments: [{ filename: 'launch.png', contentType: 'image/png', size: 64, partIndex: '0' }],
		});
		await t.mutation(api.mail.attachmentBackfill.start, { mailboxId });
		await drainScheduler(t);

		const all = await t.query(api.mail.mailbox.attachments.list, { mailboxId });
		expect(all.files.map((f) => f.filename)).toEqual(['launch.png', 'contract-v4.pdf']);
		// The row carries its parent message's subject, so the view can label it
		// without a second read per file, and the folder the message actually
		// lives in, so opening it lands on the right list pane.
		expect(all.files[1]?.subject).toBe('contract');
		expect(all.files[1]?.folderParam).toBe('inbox');

		const pdfs = await t.query(api.mail.mailbox.attachments.list, { mailboxId, kinds: ['pdf'] });
		expect(pdfs.files.map((f) => f.filename)).toEqual(['contract-v4.pdf']);

		const fromMei = await t.query(api.mail.mailbox.attachments.list, {
			mailboxId,
			fromAddress: 'mei@example.com',
		});
		expect(fromMei.files.map((f) => f.filename)).toEqual(['launch.png']);

		const recent = await t.query(api.mail.mailbox.attachments.list, {
			mailboxId,
			afterMs: base + 500,
		});
		expect(recent.files.map((f) => f.filename)).toEqual(['launch.png']);

		const facets = await t.query(api.mail.mailbox.attachments.senderFacets, { mailboxId });
		expect(facets.map((f) => f.address).sort()).toEqual([
			'ines@brightpath.example',
			'mei@example.com',
		]);
	});

	it('returns nothing for a mailbox the caller cannot read', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'user-A' });
		sessionMocks.userId = 'user-B';
		sessionMocks.role = 'editor';
		const res = await t.query(api.mail.mailbox.attachments.list, { mailboxId });
		expect(res.files).toEqual([]);
	});
});

describe('filename: searches the index, not one page of recent mail', () => {
	it('finds an attachment older than a full page of newer messages', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		const base = 1_700_000_000_000;
		await seedMessage(t, mailboxId, {
			subject: 'the old contract',
			receivedAt: base,
			attachments: [pdf('contract-v4.pdf')],
		});
		// Enough newer, attachment-less mail to push the target off the first
		// arrival-ordered page — which is exactly what the old post-filter saw.
		for (let i = 0; i < 12; i++) {
			await seedMessage(t, mailboxId, { subject: `chatter ${i}`, receivedAt: base + 1000 + i });
		}
		await t.mutation(api.mail.attachmentBackfill.start, { mailboxId });
		await drainScheduler(t);

		const hit = await t.query(api.mail.mailbox.search.search, {
			mailboxId,
			text: '',
			filename: 'contract-v4.pdf',
			limit: 5,
		});
		expect(hit.messages.map((m) => m.subject)).toEqual(['the old contract']);

		// The operator's contract is a substring match, so a filename that only
		// shares the search index's tokens must not come back.
		const miss = await t.query(api.mail.mailbox.search.search, {
			mailboxId,
			text: '',
			filename: 'invoice',
			limit: 5,
		});
		expect(miss.messages).toEqual([]);
	});

	it('composes with the rest of the grammar', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		await seedMessage(t, mailboxId, {
			subject: 'from ines',
			fromAddress: 'ines@brightpath.example',
			attachments: [pdf('report.pdf')],
		});
		await seedMessage(t, mailboxId, {
			subject: 'from mei',
			fromAddress: 'mei@example.com',
			attachments: [pdf('report.pdf')],
		});
		await t.mutation(api.mail.attachmentBackfill.start, { mailboxId });
		await drainScheduler(t);

		const res = await t.query(api.mail.mailbox.search.search, {
			mailboxId,
			text: '',
			filename: 'report',
			from: 'ines',
		});
		expect(res.messages.map((m) => m.subject)).toEqual(['from ines']);
	});
});

describe('index teardown', () => {
	it('drops a purged message’s rows so the Files view never opens into nothing', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		await seedFolder(t, mailboxId, 'trash');
		const messageId = await seedMessage(t, mailboxId, {
			subject: 'contract',
			attachments: [pdf('contract-v4.pdf')],
		});
		await t.mutation(api.mail.attachmentBackfill.start, { mailboxId });
		await drainScheduler(t);
		expect(await countIndexed(t, mailboxId)).toBe(1);

		await t.mutation(api.mail.messageActions.purge, { messageIds: [messageId] });
		expect(await countIndexed(t, mailboxId)).toBe(0);
	});
});
