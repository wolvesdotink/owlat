/**
 * Files captured from inbound mail keep their mailbox's permission (#1322).
 *
 * Every org member can read Files, but an attachment captured out of a
 * personal Postbox mailbox or the owner/admin-only Team Inbox (ADR-0040) is
 * mail, not a shared upload. Before the fix any editor could enumerate those
 * captures — with a download URL — through `semanticFiles.list` / `search` /
 * `get` / `getVersionHistory` / `listByContact`, without access to the mailbox
 * they came from. These tests drive every one of those reads as:
 *
 *   - the mailbox's own user and a shared-mailbox member (allowed),
 *   - an owner (allowed: owners and admins may open every mailbox),
 *   - an unrelated editor (denied, while uploads stay visible to them).
 *
 * The session floor is mocked to a role/user pair; the in-handler decision is
 * the real one: the mailbox gate (mail/permissions.ts) against real
 * `mailboxes` / `mailboxMembers` rows, and the shared-inbox reader rule.
 */

import { convexTest } from 'convex-test';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { enableFeatures } from './factories';
import { isInMailCaptureScope } from '../lib/semanticFileAccess';
import { isInboxDerivedKnowledge } from '../inbox/access';

const sessionMock = vi.hoisted(() => ({
	userId: 'victim',
	role: 'editor' as 'owner' | 'editor',
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	const session = () => ({
		userId: sessionMock.userId,
		role: sessionMock.role,
		activeOrganizationId: 'test-org',
	});
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session()),
		getMutationContext: vi.fn(async () => session()),
		getBetterAuthSessionWithRole: vi.fn(async () => session()),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
	};
});

const modules = import.meta.glob('../**/*.*s');

type Harness = ReturnType<typeof convexTest>;

interface Seeded {
	contactId: Id<'contacts'>;
	upload: Id<'semanticFiles'>;
	postbox: Id<'semanticFiles'>;
	teamInbox: Id<'semanticFiles'>;
	legacyPostbox: Id<'semanticFiles'>;
}

async function seed(t: Harness): Promise<Seeded> {
	await enableFeatures(t, ['postbox']);
	return t.run(async (ctx) => {
		const now = Date.now();
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'victim',
			organizationId: 'test-org',
			address: 'victim@example.com',
			domain: 'example.com',
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.insert('mailboxMembers', {
			mailboxId,
			authUserId: 'teammate',
			role: 'member',
			addedBy: 'victim',
			createdAt: now,
		});
		const contactId = await ctx.db.insert('contacts', {
			email: 'sender@example.com',
			source: 'api',
			doiStatus: 'not_required',
			createdAt: now,
			updatedAt: now,
		});
		let at = now;
		const file = async (
			filename: string,
			fields: Partial<
				Pick<Doc<'semanticFiles'>, 'sourceType' | 'captureSource' | 'sourceMailboxId'>
			>
		) => {
			at += 1;
			const storageId = await ctx.storage.store(new Blob([`confidential ${filename}`]));
			const fileId = await ctx.db.insert('semanticFiles', {
				storageId,
				filename,
				mimeType: 'text/plain',
				fileSize: 20,
				sourceType: fields.sourceType ?? 'email_attachment',
				captureSource: fields.captureSource,
				sourceMailboxId: fields.sourceMailboxId,
				sourceMessageId: '<m@example.com>',
				contactIds: [contactId],
				version: 1,
				embedding: [],
				searchableText: `confidential ${filename}`,
				createdAt: at,
				updatedAt: at,
			});
			await ctx.db.insert('semanticFileContacts', { fileId, contactId });
			return fileId;
		};
		return {
			contactId,
			upload: await file('upload.txt', { sourceType: 'upload' }),
			postbox: await file('postbox.txt', { captureSource: 'mailbox', sourceMailboxId: mailboxId }),
			teamInbox: await file('team.txt', { captureSource: 'team_inbox' }),
			// Captured before the mailbox was recorded: fails closed.
			legacyPostbox: await file('legacy.txt', { captureSource: 'mailbox' }),
		};
	});
}

/** Every Files read the issue lists, as the current session. */
async function readAll(t: Harness, seeded: Seeded) {
	const page = { cursor: null, numItems: 50 };
	const names = (rows: Array<{ filename: string }>) => rows.map((r) => r.filename).sort();
	const list = await t.query(api.semanticFiles.list, { paginationOpts: page });
	const attachments = await t.query(api.semanticFiles.list, {
		paginationOpts: page,
		sourceType: 'email_attachment',
	});
	const search = await t.query(api.semanticFiles.search, {
		paginationOpts: page,
		query: 'confidential',
	});
	const byContact = await t.query(api.semanticFiles.listByContact, {
		contactId: seeded.contactId,
	});
	const get: Record<string, boolean> = {};
	const history: Record<string, number> = {};
	for (const [key, fileId] of Object.entries(seeded)) {
		if (key === 'contactId') continue;
		const id = fileId as Id<'semanticFiles'>;
		get[key] = (await t.query(api.semanticFiles.get, { fileId: id })) !== null;
		history[key] = (await t.query(api.semanticFiles.getVersionHistory, { fileId: id })).length;
	}
	return {
		list: names(list.page),
		attachments: names(attachments.page),
		search: names(search.page),
		byContact: names(byContact),
		get,
		history,
	};
}

beforeEach(() => {
	sessionMock.userId = 'victim';
	sessionMock.role = 'editor';
});

describe('semanticFiles reads — captured mail keeps its mailbox permission', () => {
	it('hides another mailbox’s and the Team Inbox’s captures from an unrelated editor', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		sessionMock.userId = 'bystander';

		const reads = await readAll(t, seeded);
		expect(reads.list).toEqual(['upload.txt']);
		expect(reads.attachments).toEqual([]);
		expect(reads.search).toEqual(['upload.txt']);
		expect(reads.byContact).toEqual(['upload.txt']);
		expect(reads.get).toEqual({
			upload: true,
			postbox: false,
			teamInbox: false,
			legacyPostbox: false,
		});
		expect(reads.history).toEqual({ upload: 1, postbox: 0, teamInbox: 0, legacyPostbox: 0 });
	});

	it('shows a Postbox capture to its mailbox’s own user and members, nothing more', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);

		for (const userId of ['victim', 'teammate']) {
			sessionMock.userId = userId;
			const reads = await readAll(t, seeded);
			expect(reads.list).toEqual(['postbox.txt', 'upload.txt']);
			expect(reads.search).toEqual(['postbox.txt', 'upload.txt']);
			expect(reads.byContact).toEqual(['postbox.txt', 'upload.txt']);
			expect(reads.get).toEqual({
				upload: true,
				postbox: true,
				teamInbox: false,
				legacyPostbox: false,
			});
		}
	});

	it('shows every capture, including legacy ones, to an owner', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		sessionMock.userId = 'boss';
		sessionMock.role = 'owner';

		const reads = await readAll(t, seeded);
		expect(reads.list).toEqual(['legacy.txt', 'postbox.txt', 'team.txt', 'upload.txt']);
		expect(reads.get).toEqual({
			upload: true,
			postbox: true,
			teamInbox: true,
			legacyPostbox: true,
		});
	});

	it('hides a Postbox capture from its own user once personal mail is off', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		await t.run(async (ctx) => {
			const off = { postbox: false, 'mail.external': false };
			const settings = await ctx.db.query('instanceSettings').first();
			await ctx.db.patch(settings!._id, {
				featureFlags: { ...settings!.featureFlags, ...off },
			});
		});

		const reads = await readAll(t, seeded);
		expect(reads.get['postbox']).toBe(false);
		expect(reads.list).toEqual(['upload.txt']);
	});
});

describe('retrieval and derived knowledge keep the same boundary', () => {
	it('a session-less file search returns captures only within the scope it names', () => {
		const upload = { captureSource: undefined };
		const postbox = { captureSource: 'mailbox' as const };
		const team = { captureSource: 'team_inbox' as const };
		expect([upload, postbox, team].map((f) => isInMailCaptureScope(f, 'none'))).toEqual([
			true,
			false,
			false,
		]);
		expect([upload, postbox, team].map((f) => isInMailCaptureScope(f, 'team_inbox'))).toEqual([
			true,
			false,
			true,
		]);
		expect([upload, postbox, team].map((f) => isInMailCaptureScope(f, 'all'))).toEqual([
			true,
			true,
			true,
		]);
	});

	it('knowledge extracted from a captured file is Team Inbox-derived', () => {
		expect(isInboxDerivedKnowledge({ sourceType: 'file' })).toBe(false);
		expect(isInboxDerivedKnowledge({ sourceType: 'file', captureSource: 'mailbox' })).toBe(true);
		expect(isInboxDerivedKnowledge({ sourceType: 'file', captureSource: 'team_inbox' })).toBe(true);
	});
});
