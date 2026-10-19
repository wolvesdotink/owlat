/**
 * A file's version history, legacy and paged (plan item OW-075).
 *
 *   - `semanticFiles.getVersionHistory` keeps its shape and still walks a whole
 *     acyclic chain, however long; a chain that loops back stops at the first
 *     revisited row instead of spinning until the query fails.
 *   - `files.history.list` walks at most VERSION_HISTORY_PAGE_BUDGET rows per
 *     call, returns compact rows, and says truthfully whether more remain and
 *     where they start. Every walked row goes through semanticFileReadGate: an
 *     unreadable version is left out but walked through (and counts against the
 *     budget), so a permitted older version behind it is still reached. The
 *     cursor is an opaque token bound to the caller, the organization and the
 *     origin `fileId`, so it cannot be redeemed against another history, and
 *     every cursor that does not continue the caller's own walk is refused
 *     with one identical error.
 *
 * The session floor is mocked to a role/user pair; the read gate is the real
 * one (`team_inbox` captures are for shared-inbox readers only).
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import type { FunctionReturnType } from 'convex/server';
import { api } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { VERSION_HISTORY_PAGE_BUDGET } from '../files/history';

const sessionMock = vi.hoisted(() => ({
	userId: 'reader',
	role: 'owner' as 'owner' | 'editor',
	organizationId: 'test-org',
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	const session = () => ({
		userId: sessionMock.userId,
		role: sessionMock.role,
		activeOrganizationId: sessionMock.organizationId,
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
type FileId = Id<'semanticFiles'>;
type HistoryPage = FunctionReturnType<typeof api.files.history.list>;
type VersionFields = Partial<Pick<Doc<'semanticFiles'>, 'captureSource' | 'sourceType'>> & {
	released?: boolean;
};

/**
 * A chain of `length` versions, oldest inserted first, each pointing at the
 * one before. `fields(i)` shapes version i (0 = newest). Returns ids newest
 * first, the order every history reader walks.
 */
async function seedChain(
	t: Harness,
	length: number,
	fields: (index: number) => VersionFields = () => ({})
): Promise<FileId[]> {
	return t.run(async (ctx) => {
		const ids: FileId[] = [];
		let previous: FileId | undefined;
		for (let version = 1; version <= length; version++) {
			const index = length - version;
			const { released, captureSource, sourceType } = fields(index);
			const storageId = released
				? undefined
				: await ctx.storage.store(new Blob([`version ${version}`]));
			previous = await ctx.db.insert('semanticFiles', {
				storageId,
				filename: `report-v${version}.txt`,
				mimeType: 'text/plain',
				fileSize: 100 + version,
				sourceType: sourceType ?? (captureSource ? 'email_attachment' : 'upload'),
				captureSource,
				version,
				previousVersionId: previous,
				changeSummary: version > 1 ? `change ${version}` : undefined,
				extractedText: 'long extracted text '.repeat(50),
				embedding: Array.from({ length: 8 }, () => 0.5),
				createdAt: version,
				updatedAt: version,
			});
			ids.unshift(previous);
		}
		return ids;
	});
}

/** Point `from` at `to`, making a loop out of an existing chain. */
async function link(t: Harness, from: FileId, to: FileId) {
	await t.run(async (ctx) => {
		await ctx.db.patch(from, { previousVersionId: to });
	});
}

async function legacyIds(t: Harness, fileId: FileId) {
	const rows = await t.query(api.semanticFiles.getVersionHistory, { fileId });
	return rows.map((row) => row._id);
}

/** Every page of the new endpoint, following `continueCursor` to the end. */
async function allPages(t: Harness, fileId: FileId) {
	const pages: HistoryPage[] = [];
	let cursor: string | null = null;
	do {
		const result: HistoryPage = await t.query(api.files.history.list, { fileId, cursor });
		pages.push(result);
		cursor = result.continueCursor;
		if (pages.length > 20) throw new Error('paging did not finish');
	} while (cursor !== null);
	return pages;
}

const INVALID_CURSOR = /^.*Invalid version history cursor.*$/;

/** The error a call fails with, or the result when it does not fail. */
async function failure(promise: Promise<unknown>): Promise<string> {
	try {
		return `resolved: ${JSON.stringify(await promise)}`;
	} catch (error) {
		return String(error instanceof Error ? error.message : error);
	}
}

beforeEach(() => {
	sessionMock.userId = 'reader';
	sessionMock.role = 'owner';
	sessionMock.organizationId = 'test-org';
	vi.stubEnv('INSTANCE_SECRET', 'test-instance-secret-for-history-cursors');
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('semanticFiles.getVersionHistory (legacy)', () => {
	it('returns every version of an acyclic chain whole, newest first, with no cap', async () => {
		const t = convexTest(schema, modules);
		const ids = await seedChain(t, VERSION_HISTORY_PAGE_BUDGET * 2 + 5);

		const rows = await t.query(api.semanticFiles.getVersionHistory, { fileId: ids[0]! });
		expect(rows.map((row) => row._id)).toEqual(ids);
		// The legacy shape: the whole document plus its storage URL.
		expect(rows[0]).toMatchObject({
			filename: `report-v${ids.length}.txt`,
			previousVersionId: ids[1],
			embedding: expect.any(Array),
			extractedText: expect.any(String),
			url: expect.any(String),
		});
	});

	it('stops at the first revisited version when the stored chain loops', async () => {
		const t = convexTest(schema, modules);
		const ids = await seedChain(t, 3);
		await link(t, ids[2]!, ids[0]!);
		expect(await legacyIds(t, ids[0]!)).toEqual(ids);
		expect(await legacyIds(t, ids[1]!)).toEqual([ids[1], ids[2], ids[0]]);

		const [single] = await seedChain(t, 1);
		await link(t, single!, single!);
		expect(await legacyIds(t, single!)).toEqual([single]);
	});

	it('still skips an unreadable version and reaches the readable ones behind it', async () => {
		const t = convexTest(schema, modules);
		const ids = await seedChain(t, 4, (i) =>
			i === 1 || i === 2 ? { captureSource: 'team_inbox' } : {}
		);
		sessionMock.role = 'editor';
		expect(await legacyIds(t, ids[0]!)).toEqual([ids[0], ids[3]]);
	});
});

describe('files.history.list', () => {
	it('pages a long chain under the budget with truthful continuation', async () => {
		const t = convexTest(schema, modules);
		const ids = await seedChain(t, VERSION_HISTORY_PAGE_BUDGET * 2 + 5);

		const pages = await allPages(t, ids[0]!);
		expect(pages.map((page) => page.page.length)).toEqual([
			VERSION_HISTORY_PAGE_BUDGET,
			VERSION_HISTORY_PAGE_BUDGET,
			5,
		]);
		expect(pages.map((page) => page.isDone)).toEqual([false, false, true]);
		expect(pages[2]!.continueCursor).toBeNull();
		// The cursor is opaque: it does not carry the next version's id.
		for (const page of pages.slice(0, 2)) {
			expect(page.continueCursor).toEqual(expect.any(String));
			for (const id of ids) expect(page.continueCursor).not.toContain(id);
		}
		// Together the pages are exactly the legacy history.
		expect(pages.flatMap((page) => page.page.map((row) => row._id))).toEqual(
			await legacyIds(t, ids[0]!)
		);
	});

	it('mints the same cursor every time the same page is read', async () => {
		const t = convexTest(schema, modules);
		const ids = await seedChain(t, VERSION_HISTORY_PAGE_BUDGET + 1);

		const first = await t.query(api.files.history.list, { fileId: ids[0]! });
		const again = await t.query(api.files.history.list, { fileId: ids[0]! });
		expect(first.continueCursor).toEqual(expect.any(String));
		expect(again.continueCursor).toBe(first.continueCursor);
	});

	it('returns compact rows, not whole documents', async () => {
		const t = convexTest(schema, modules);
		const ids = await seedChain(t, 2, (i) => (i === 1 ? { released: true } : {}));

		const { page } = await t.query(api.files.history.list, { fileId: ids[0]! });
		expect(Object.keys(page[0]!).sort()).toEqual(
			['_id', 'changeSummary', 'createdAt', 'fileSize', 'filename', 'url', 'version'].sort()
		);
		expect(page[0]).toMatchObject({
			filename: 'report-v2.txt',
			version: 2,
			url: expect.any(String),
		});
		// The oldest version's bytes were released: no URL, no change summary.
		expect(page[1]).toEqual({
			_id: ids[1],
			filename: 'report-v1.txt',
			fileSize: 101,
			version: 1,
			createdAt: 1,
			url: null,
		});
	});

	it('walks through unreadable versions, which count against the budget, to the readable ones behind them', async () => {
		const t = convexTest(schema, modules);
		// A readable newest upload, then two pages' worth of Team Inbox captures,
		// then uploads again.
		const run = VERSION_HISTORY_PAGE_BUDGET * 2;
		const ids = await seedChain(t, run + 5, (i) =>
			i >= 1 && i <= run ? { captureSource: 'team_inbox' } : {}
		);
		sessionMock.role = 'editor';

		const pages = await allPages(t, ids[0]!);
		expect(pages.map((page) => page.page.map((row) => row._id))).toEqual([
			[ids[0]],
			// A page of unreadable versions only: empty, and not done.
			[],
			ids.slice(run + 1),
		]);
		expect(pages.map((page) => page.isDone)).toEqual([false, false, true]);
		// The first cursor continues at an unreadable capture without naming it.
		expect(pages[0]!.continueCursor).not.toContain(ids[VERSION_HISTORY_PAGE_BUDGET]!);

		// An owner may read the captures: the same walk shows every version.
		sessionMock.role = 'owner';
		const owner = await allPages(t, ids[0]!);
		expect(owner.flatMap((page) => page.page.map((row) => row._id))).toEqual(ids);
	});

	it('is empty and done for a version the caller may not read, and refuses any cursor with it', async () => {
		const t = convexTest(schema, modules);
		const ids = await seedChain(t, VERSION_HISTORY_PAGE_BUDGET + 5, (i) =>
			i === 0 ? { captureSource: 'team_inbox' } : {}
		);
		const asOwner = await t.query(api.files.history.list, { fileId: ids[0]! });
		expect(asOwner.isDone).toBe(false);

		sessionMock.role = 'editor';
		expect(await t.query(api.files.history.list, { fileId: ids[0]! })).toEqual({
			page: [],
			isDone: true,
			continueCursor: null,
		});
		await expect(
			t.query(api.files.history.list, { fileId: ids[0]!, cursor: asOwner.continueCursor })
		).rejects.toThrow(INVALID_CURSOR);
	});

	it("refuses every cursor that does not continue this caller's walk of this history, identically", async () => {
		const t = convexTest(schema, modules);
		const ids = await seedChain(t, VERSION_HISTORY_PAGE_BUDGET + 5);
		const [otherHead] = await seedChain(t, 3);
		const { continueCursor: cursor } = await t.query(api.files.history.list, {
			fileId: ids[0]!,
		});
		expect(cursor).toEqual(expect.any(String));
		const token = cursor!;
		const list = (fileId: FileId, value: string) =>
			failure(t.query(api.files.history.list, { fileId, cursor: value }));

		const answers: Record<string, string> = {};
		// Redeemed against another, readable history.
		answers['otherHistory'] = await list(otherHead!, token);
		// By another member of the same organization.
		sessionMock.userId = 'someone-else';
		answers['otherUser'] = await list(ids[0]!, token);
		sessionMock.userId = 'reader';
		// From another organization.
		sessionMock.organizationId = 'other-org';
		answers['otherOrganization'] = await list(ids[0]!, token);
		sessionMock.organizationId = 'test-org';
		// Tampered with, malformed, empty, or a bare document id.
		const parts = token.split('.');
		const last = parts[3]!;
		parts[3] = `${last.slice(0, -1)}${last.endsWith('A') ? 'B' : 'A'}`;
		answers['tampered'] = await list(ids[0]!, parts.join('.'));
		answers['malformed'] = await list(ids[0]!, 'not-a-cursor');
		answers['empty'] = await list(ids[0]!, '');
		answers['bareId'] = await list(ids[0]!, ids[VERSION_HISTORY_PAGE_BUDGET]!);
		// A genuine cursor whose version was deleted since.
		await t.run(async (ctx) => {
			await ctx.db.delete(ids[VERSION_HISTORY_PAGE_BUDGET]!);
		});
		answers['deletedTarget'] = await list(ids[0]!, token);

		for (const answer of Object.values(answers)) expect(answer).toMatch(INVALID_CURSOR);
		expect(new Set(Object.values(answers)).size).toBe(1);
	});

	it('says more versions exist but offers no cursor without INSTANCE_SECRET', async () => {
		const t = convexTest(schema, modules);
		vi.stubEnv('INSTANCE_SECRET', '');
		const ids = await seedChain(t, VERSION_HISTORY_PAGE_BUDGET + 1);

		const result = await t.query(api.files.history.list, { fileId: ids[0]! });
		expect(result.page).toHaveLength(VERSION_HISTORY_PAGE_BUDGET);
		expect(result.isDone).toBe(false);
		expect(result.continueCursor).toBeNull();
	});

	it('ends at a deleted version, as the legacy walk does', async () => {
		const t = convexTest(schema, modules);
		const ids = await seedChain(t, 3);
		await t.run(async (ctx) => {
			await ctx.db.delete(ids[1]!);
		});

		const result = await t.query(api.files.history.list, { fileId: ids[0]! });
		expect(result.page.map((row) => row._id)).toEqual([ids[0]]);
		expect(result.isDone).toBe(true);
		expect(result.continueCursor).toBeNull();
		expect(await legacyIds(t, ids[0]!)).toEqual([ids[0]]);

		const gone = await t.query(api.files.history.list, { fileId: ids[1]! });
		expect(gone).toEqual({ page: [], isDone: true, continueCursor: null });
	});

	it('is done when a loop brings the walk back to a version it already read', async () => {
		const t = convexTest(schema, modules);
		const ids = await seedChain(t, 3);
		await link(t, ids[2]!, ids[0]!);

		const result = await t.query(api.files.history.list, { fileId: ids[0]! });
		expect(result.page.map((row) => row._id)).toEqual(ids);
		expect(result.isDone).toBe(true);
		expect(result.continueCursor).toBeNull();
	});
});
