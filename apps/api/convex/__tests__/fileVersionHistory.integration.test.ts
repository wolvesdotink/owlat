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
 *     budget), so a permitted older version behind it is still reached.
 *
 * The session floor is mocked to a role/user pair; the read gate is the real
 * one (`team_inbox` captures are for shared-inbox readers only).
 */

import { convexTest } from 'convex-test';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import type { FunctionReturnType } from 'convex/server';
import { api } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { VERSION_HISTORY_PAGE_BUDGET } from '../files/history';

const sessionMock = vi.hoisted(() => ({
	userId: 'reader',
	role: 'owner' as 'owner' | 'editor',
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

beforeEach(() => {
	sessionMock.userId = 'reader';
	sessionMock.role = 'owner';
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
		// The cursor is the next version to walk; the last page has none.
		expect(pages[0]!.continueCursor).toBe(ids[VERSION_HISTORY_PAGE_BUDGET]);
		expect(pages[1]!.continueCursor).toBe(ids[VERSION_HISTORY_PAGE_BUDGET * 2]);
		expect(pages[2]!.continueCursor).toBeNull();
		// Together the pages are exactly the legacy history.
		expect(pages.flatMap((page) => page.page.map((row) => row._id))).toEqual(
			await legacyIds(t, ids[0]!)
		);
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

	it('leaves unreadable versions out but walks through them, and they count against the budget', async () => {
		const t = convexTest(schema, modules);
		// Newest upload, then a run of Team Inbox captures longer than one page,
		// then uploads again.
		const ids = await seedChain(t, VERSION_HISTORY_PAGE_BUDGET + 5, (i) =>
			i >= 1 && i <= VERSION_HISTORY_PAGE_BUDGET ? { captureSource: 'team_inbox' } : {}
		);
		sessionMock.role = 'editor';

		const pages = await allPages(t, ids[0]!);
		expect(pages).toHaveLength(2);
		expect(pages[0]!.page.map((row) => row._id)).toEqual([ids[0]]);
		expect(pages[0]!.isDone).toBe(false);
		expect(pages[1]!.page.map((row) => row._id)).toEqual(
			ids.slice(VERSION_HISTORY_PAGE_BUDGET + 1)
		);
		expect(pages[1]!.isDone).toBe(true);

		// A page can be empty and still not done.
		const empty = await t.query(api.files.history.list, { fileId: ids[1]! });
		expect(empty.page).toEqual([]);
		expect(empty.isDone).toBe(false);

		// An owner may read the captures: the same walk shows every version.
		sessionMock.role = 'owner';
		const owner = await allPages(t, ids[0]!);
		expect(owner.flatMap((page) => page.page.map((row) => row._id))).toEqual(ids);
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

	it('refuses a cursor that is not a file id', async () => {
		const t = convexTest(schema, modules);
		const ids = await seedChain(t, 1);
		const contactId = await t.run((ctx) =>
			ctx.db.insert('contacts', {
				email: 'someone@example.com',
				source: 'api',
				doiStatus: 'not_required',
				createdAt: 1,
				updatedAt: 1,
			})
		);

		for (const cursor of ['not-an-id', contactId]) {
			await expect(t.query(api.files.history.list, { fileId: ids[0]!, cursor })).rejects.toThrow(
				/cursor/
			);
		}
	});
});
