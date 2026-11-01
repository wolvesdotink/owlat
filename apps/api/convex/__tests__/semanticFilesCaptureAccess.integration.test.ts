/**
 * Files captured from inbound mail keep their mailbox's permission.
 *
 * Every org member can read Files, but an attachment captured out of a
 * personal Postbox mailbox or the owner/admin-only Team Inbox is
 * mail, not a shared upload. An editor without access to the mailbox a capture
 * came from must not enumerate it — with a download URL — through
 * `files.cards.list` / `search` / `listByContact`, `files.library.get` or
 * `files.history.list`, nor through the by-source `listBySource` /
 * `searchBySource` over a full walk. These tests drive every one of those
 * reads as:
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
import { api, internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { enableFeatures } from './factories';

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
		getSingletonOrganizationId: vi.fn(async () => 'test-org'),
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
	unmarked: Id<'semanticFiles'>;
	mailboxId: Id<'mailboxes'>;
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
			// Captured before `captureSource` existed (v0.4.17): only the source type.
			unmarked: await file('unmarked.txt', {}),
			mailboxId,
		};
	});
}

/** Every filename a paginated read returns, walked to the end two at a time. */
async function walkNames(
	read: (paginationOpts: {
		cursor: string | null;
		numItems: number;
	}) => Promise<{ page: Array<{ filename: string }>; isDone: boolean; continueCursor: string }>
): Promise<string[]> {
	const filenames: string[] = [];
	let cursor: string | null = null;
	for (let guard = 0; guard < 20; guard++) {
		const res = await read({ cursor, numItems: 2 });
		filenames.push(...res.page.map((r) => r.filename));
		if (res.isDone) return filenames.sort();
		cursor = res.continueCursor;
	}
	throw new Error('walk did not finish');
}

/** Every Files read the issue lists, as the current session. */
async function readAll(t: Harness, seeded: Seeded) {
	const page = { cursor: null, numItems: 50 };
	const names = (rows: Array<{ filename: string }>) => rows.map((r) => r.filename).sort();
	const list = await t.query(api.files.cards.list, { paginationOpts: page });
	const attachments = await t.query(api.files.cards.list, {
		paginationOpts: page,
		sourceType: 'email_attachment',
	});
	const search = await t.query(api.files.cards.search, {
		paginationOpts: page,
		query: 'confidential',
	});
	const byContact = await t.query(api.files.cards.listByContact, {
		contactId: seeded.contactId,
	});
	// The by-source endpoints narrow through their own index first, then run
	// the same gate: a full walk in small pages, per source, must reach exactly
	// what the post-pagination filter over one large page returns.
	for (const sourceType of ['upload', 'email_attachment', 'agent_generated'] as const) {
		const filteredList = await t.query(api.files.cards.list, { paginationOpts: page, sourceType });
		const filteredSearch = await t.query(api.files.cards.search, {
			paginationOpts: page,
			query: 'confidential',
			sourceType,
		});
		const bySource = await walkNames((paginationOpts) =>
			t.query(api.files.cards.listBySource, { paginationOpts, sourceType })
		);
		const searchBySource = await walkNames((paginationOpts) =>
			t.query(api.files.cards.searchBySource, {
				paginationOpts,
				query: 'confidential',
				sourceType,
			})
		);
		expect(bySource).toEqual(names(filteredList.page));
		expect(searchBySource).toEqual(names(filteredSearch.page));
	}
	const get: Record<string, boolean> = {};
	const history: Record<string, number> = {};
	for (const [key, fileId] of Object.entries(seeded)) {
		if (key === 'contactId' || key === 'mailboxId') continue;
		const id = fileId as Id<'semanticFiles'>;
		get[key] = (await t.query(api.files.library.get, { fileId: id })) !== null;
		history[key] = (
			await t.query(api.files.history.list, { fileId: id, cursor: null })
		).page.length;
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

describe('Files reads — captured mail keeps its mailbox permission', () => {
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
			unmarked: false,
		});
		expect(reads.history).toEqual({
			upload: 1,
			postbox: 0,
			teamInbox: 0,
			legacyPostbox: 0,
			unmarked: 0,
		});
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
				unmarked: false,
			});
		}
	});

	it('shows every capture, including legacy ones, to an owner', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		sessionMock.userId = 'boss';
		sessionMock.role = 'owner';

		const reads = await readAll(t, seeded);
		expect(reads.list).toEqual([
			'legacy.txt',
			'postbox.txt',
			'team.txt',
			'unmarked.txt',
			'upload.txt',
		]);
		expect(reads.get).toEqual({
			upload: true,
			postbox: true,
			teamInbox: true,
			legacyPostbox: true,
			unmarked: true,
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

describe('files/pipeline.getByIds — what a session-less search may hydrate', () => {
	async function retrieve(
		t: Harness,
		seeded: Seeded,
		mailCaptures?: 'none' | 'team_inbox' | 'all'
	) {
		const ids = [
			seeded.upload,
			seeded.postbox,
			seeded.teamInbox,
			seeded.legacyPostbox,
			seeded.unmarked,
		];
		const rows = await t.query(internal.files.pipeline.getByIds, {
			ids,
			...(mailCaptures ? { mailCaptures } : {}),
		});
		return rows.map((r) => r.filename).sort();
	}

	it('keeps mail captures to the named scope, and to none when no scope is named', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		expect(await retrieve(t, seeded)).toEqual(['upload.txt']);
		expect(await retrieve(t, seeded, 'none')).toEqual(['upload.txt']);
		expect(await retrieve(t, seeded, 'team_inbox')).toEqual(['team.txt', 'upload.txt']);
		expect(await retrieve(t, seeded, 'all')).toEqual([
			'legacy.txt',
			'postbox.txt',
			'team.txt',
			'unmarked.txt',
			'upload.txt',
		]);
	});

	it("under 'all', applies the mailbox gate's status and feature checks", async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		await t.run((ctx) => ctx.db.patch(seeded.mailboxId, { status: 'suspended' }));
		expect(await retrieve(t, seeded, 'all')).not.toContain('postbox.txt');

		await t.run((ctx) => ctx.db.patch(seeded.mailboxId, { status: 'active' }));
		await t.run(async (ctx) => {
			const settings = await ctx.db.query('instanceSettings').first();
			await ctx.db.patch(settings!._id, {
				featureFlags: { ...settings!.featureFlags, postbox: false, 'mail.external': false },
			});
		});
		expect(await retrieve(t, seeded, 'all')).not.toContain('postbox.txt');

		await t.run((ctx) => ctx.db.delete(seeded.mailboxId));
		expect(await retrieve(t, seeded, 'all')).not.toContain('postbox.txt');
	});
});
