/**
 * The Postbox list reads addressed by folder id (plan C7).
 *
 * `listMessages` and `listSections` used to resolve the folder by role, which
 * reads the folder document. IMAP bookkeeping patches that document on every
 * delivery and flag change, so a mark-read anywhere in the folder re-ran the
 * subscribed first page. With a folder id the handlers must not read the
 * folder document at all, and must still refuse a folder the mailbox does not
 * own. The by-role calls keep working for clients that have no id yet.
 *
 * "Does not read the folder document" is pinned by deleting the document: a
 * handler that still reads it returns nothing.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api } from '../../_generated/api';
import { modules, seedMailbox, seedFolder, seedMessage } from './helpers.testlib';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn(async () => ({ userId: 'user-A', role: 'owner' })),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => ({ userId: 'user-A', role: 'owner' })),
		getBetterAuthSessionWithRole: vi.fn(async () => ({
			userId: 'user-A',
			role: 'owner',
			activeOrganizationId: 'org-1',
		})),
	};
});

async function seedInbox(t: TestConvex<typeof schema>) {
	const mailboxId = await seedMailbox(t);
	const inboxId = await seedFolder(t, mailboxId);
	await seedMessage(t, mailboxId, { subject: 'older', receivedAt: Date.now() - 60_000 });
	await seedMessage(t, mailboxId, { subject: 'newer' });
	return { mailboxId, inboxId };
}

/** A second mailbox in another org, with one message in its inbox. */
async function seedForeignInbox(t: TestConvex<typeof schema>): Promise<Id<'mailFolders'>> {
	const otherId = await seedMailbox(t, {
		userId: 'user-B',
		organizationId: 'org-2',
		address: 'b@owlat.test',
	});
	const folderId = await seedFolder(t, otherId);
	await seedMessage(t, otherId, { subject: 'theirs' });
	return folderId;
}

async function deleteFolderDoc(t: TestConvex<typeof schema>, folderId: Id<'mailFolders'>) {
	await t.run(async (ctx) => {
		await ctx.db.delete(folderId);
	});
}

describe('mail.mailbox.queries.listMessages by folder id', () => {
	it('lists a role folder addressed by id exactly as by role', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, inboxId } = await seedInbox(t);

		const byRole = await t.query(api.mail.mailbox.queries.listMessages, {
			mailboxId,
			folderRole: 'inbox',
		});
		const byId = await t.query(api.mail.mailbox.queries.listMessages, {
			mailboxId,
			folderId: inboxId,
		});
		expect(byId.messages.map((m) => m.subject)).toEqual(['newer', 'older']);
		expect(byId.messages.map((m) => m._id)).toEqual(byRole.messages.map((m) => m._id));
	});

	it('does not read the folder document', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, inboxId } = await seedInbox(t);
		await deleteFolderDoc(t, inboxId);

		const byId = await t.query(api.mail.mailbox.queries.listMessages, {
			mailboxId,
			folderId: inboxId,
		});
		expect(byId.messages).toHaveLength(2);
	});

	it('returns nothing for another mailbox folder id', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedInbox(t);
		const foreignId = await seedForeignInbox(t);

		const result = await t.query(api.mail.mailbox.queries.listMessages, {
			mailboxId,
			folderId: foreignId,
		});
		expect(result).toEqual({ messages: [], hasMore: false, nextCursor: null });
	});
});

describe('mail.sections.listSections by folder id', () => {
	it('reads the same sections by id as by role', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, inboxId } = await seedInbox(t);

		const byRole = await t.query(api.mail.sections.listSections, { mailboxId });
		const byId = await t.query(api.mail.sections.listSections, { mailboxId, folderId: inboxId });
		expect(byRole.sections[0]?.messages.map((m) => m.subject)).toEqual(['newer', 'older']);
		expect(byId.sections.map((s) => s.messages.map((m) => m._id))).toEqual(
			byRole.sections.map((s) => s.messages.map((m) => m._id))
		);
	});

	it('does not read the folder document', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, inboxId } = await seedInbox(t);
		await deleteFolderDoc(t, inboxId);

		const { sections } = await t.query(api.mail.sections.listSections, {
			mailboxId,
			folderId: inboxId,
		});
		expect(sections[0]?.messages).toHaveLength(2);
	});

	it('returns nothing for another mailbox folder id', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedInbox(t);
		const foreignId = await seedForeignInbox(t);

		const { sections } = await t.query(api.mail.sections.listSections, {
			mailboxId,
			folderId: foreignId,
		});
		expect(sections).toEqual([]);
	});
});
