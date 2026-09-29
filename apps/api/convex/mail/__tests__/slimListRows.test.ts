/**
 * Plan 2.3 — the Postbox list reads return SLIM rows.
 *
 * `listMessages`, `listByLabel`, `listSections` and `search` used to hand back
 * whole `mailMessages` docs, unsealing each row's inline text/html body (up to
 * 64 KB apiece) on every run, so a 50-row page could weigh several MB. They now
 * project each message onto `MailListRow`: the fields the list and the reader
 * header render, no bodies. The reader loads bodies through its own queries.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';
import type { DatabaseWriter } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { modules, seedMailbox, seedFolder, seedMessage } from './helpers.testlib';

const sessionMocks = vi.hoisted(() => ({
	getBetterAuthSessionWithRole: vi.fn(),
}));
vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		getBetterAuthSessionWithRole: sessionMocks.getBetterAuthSessionWithRole,
	};
});

beforeEach(() => {
	sessionMocks.getBetterAuthSessionWithRole.mockResolvedValue({
		userId: 'test-user',
		role: 'owner',
		activeOrganizationId: 'test-org',
	});
});

type T = ReturnType<typeof convexTest>;

/** Columns a list row must never carry: bodies, their blobs, raw headers. */
const FORBIDDEN_KEYS = [
	'textBodyInline',
	'htmlBodyInline',
	'searchBody',
	'textBodyStorageId',
	'htmlBodyStorageId',
	'rawStorageId',
	'references',
	'outbound',
] as const;

const BODY_BYTES = 20 * 1024;
const ROWS = 50;

async function seedInbox(t: T): Promise<Id<'mailboxes'>> {
	const mailboxId = await seedMailbox(t, {
		userId: 'test-user',
		organizationId: 'test-org',
		address: 'me@example.com',
		domain: 'example.com',
	});
	await seedFolder(t, mailboxId, 'inbox');
	return mailboxId;
}

/** Seed `count` messages, each with a 20 KB text AND a 20 KB html body. */
async function seedHeavyMessages(
	t: T,
	mailboxId: Id<'mailboxes'>,
	count: number,
	over: { pinnedSection?: string } = {}
): Promise<Id<'mailMessages'>[]> {
	const ids: Id<'mailMessages'>[] = [];
	const base = Date.now() - count * 1000;
	for (let i = 0; i < count; i++) {
		ids.push(
			await seedMessage(t, mailboxId, {
				subject: `Report ${i}`,
				snippet: `Quarterly report number ${i}`,
				fromAddress: 'reports@example.com',
				receivedAt: base + i * 1000,
				textBodyInline: 't'.repeat(BODY_BYTES),
				htmlBodyInline: `<p>${'h'.repeat(BODY_BYTES)}</p>`,
				searchBody: 's'.repeat(8 * 1024),
				...(over.pinnedSection ? { pinnedSection: over.pinnedSection } : {}),
			})
		);
	}
	return ids;
}

function expectSlim(row: object): void {
	for (const key of FORBIDDEN_KEYS) expect(row).not.toHaveProperty(key);
}

/** The bound a 50-row page must fit in: well under one body per row. */
const PAGE_BYTE_BOUND = ROWS * 2 * 1024;

describe('slim list rows (plan 2.3)', () => {
	it('listMessages: 50 rows with 20 KB bodies fit in a small payload', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedInbox(t);
		await seedHeavyMessages(t, mailboxId, ROWS);

		const result = await t.query(api.mail.mailbox.queries.listMessages, {
			mailboxId,
			folderRole: 'inbox',
			limit: ROWS,
		});
		expect(result.messages).toHaveLength(ROWS);
		for (const row of result.messages) expectSlim(row);

		const payload = JSON.stringify(result).length;
		// The bodies alone would be 50 × (20 KB text + 20 KB html + 8 KB search).
		expect(payload).toBeLessThan(PAGE_BYTE_BOUND);
		expect(payload).toBeLessThan(ROWS * BODY_BYTES * 2 * 0.05);
	});

	it('listMessages: a row still carries what the list and reader header render', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedInbox(t);
		const [messageId] = await seedHeavyMessages(t, mailboxId, 1);

		const { messages } = await t.query(api.mail.mailbox.queries.listMessages, {
			mailboxId,
			folderRole: 'inbox',
		});
		const row = messages[0]!;
		expect(row._id).toBe(messageId);
		expect(row).toMatchObject({
			mailboxId,
			fromAddress: 'reports@example.com',
			toAddresses: ['me@example.com'],
			ccAddresses: [],
			subject: 'Report 0',
			snippet: 'Quarterly report number 0',
			flagSeen: false,
			flagFlagged: false,
			hasAttachments: false,
			attachments: [],
			labelIds: [],
		});
		expect(typeof row.threadId).toBe('string');
		expect(typeof row.folderId).toBe('string');
		expect(typeof row.receivedAt).toBe('number');
		// Absent optional columns stay absent rather than riding as `undefined`.
		expect(Object.values(row)).not.toContain(undefined);
	});

	it('listByLabel, listSections and search return slim rows too', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedInbox(t);
		const [labelled] = await seedHeavyMessages(t, mailboxId, 3);
		const labelId = await t.run(async (ctx: { db: DatabaseWriter }) => {
			const id = await ctx.db.insert('mailLabels', {
				mailboxId,
				name: 'Reports',
				createdAt: Date.now(),
			});
			await ctx.db.patch(labelled!, { labelIds: [id] });
			return id;
		});

		const byLabel = await t.query(api.mail.mailbox.queries.listByLabel, { mailboxId, labelId });
		expect(byLabel.messages).toHaveLength(1);
		expectSlim(byLabel.messages[0]!);
		expect(byLabel.messages[0]!.labelIds).toEqual([labelId]);

		const { sections } = await t.query(api.mail.sections.listSections, { mailboxId });
		const rows = sections.flatMap((s) => s.messages);
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) expectSlim(row);

		const found = await t.query(api.mail.mailbox.search.search, {
			mailboxId,
			text: '',
			from: 'reports',
		});
		expect(found.messages).toHaveLength(3);
		for (const row of found.messages) expectSlim(row);
		// Fan-out search goes through the same projection.
		const fanned = await t.query(api.mail.mailbox.search.search, { text: '' });
		expect(fanned.messages.length).toBeGreaterThan(0);
		for (const row of fanned.messages) expectSlim(row);
	});

	it('the reader queries still return the body', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedInbox(t);
		const [messageId] = await seedHeavyMessages(t, mailboxId, 1);

		const message = await t.query(api.mail.mailbox.messages.getMessage, {
			messageId: messageId!,
		});
		expect(message?.textBodyInline).toHaveLength(BODY_BYTES);
		const thread = await t.query(api.mail.mailbox.messages.listThreadMessages, {
			messageId: messageId!,
		});
		expect(thread?.messages[0]?.textBodyInline).toHaveLength(BODY_BYTES);
	});
});
