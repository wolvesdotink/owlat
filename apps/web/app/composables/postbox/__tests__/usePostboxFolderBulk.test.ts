/**
 * usePostboxFolderBulk: "Mark all as read" walks a folder, a label, a category,
 * a bundle or several mailboxes' folders batch by batch, and its Undo puts back
 * exactly the messages it flipped; "Empty" asks first and is only offered to
 * someone the server would let do it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

let stateBuckets: Map<string, any>;
let runners: Array<ReturnType<typeof vi.fn>>;
let registered: Array<{ label: string; inverse: () => Promise<void> }>;
let myRole: ReturnType<typeof ref<string | null>>;

beforeEach(() => {
	stateBuckets = new Map();
	runners = [];
	registered = [];
	myRole = ref<string | null>('owner');
	vi.stubGlobal('useState', (key: string, init: () => unknown) => {
		if (!stateBuckets.has(key)) stateBuckets.set(key, ref(init()));
		return stateBuckets.get(key);
	});
	vi.stubGlobal('useI18n', () => ({ t: (k: string) => k }));
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	vi.stubGlobal('useConvexQuery', () => ({ data: myRole }));
	// Created in order: the mark-read batch, setFlags (Undo), emptyFolder, the
	// category batch, the label batch.
	vi.stubGlobal('useBackendOperation', () => {
		const run = vi.fn(async () => ({ ok: true, result: {} }));
		runners.push(run);
		return { run, isLoading: ref(false) };
	});
	vi.stubGlobal('usePostboxTriageUndo', () => ({
		register: (entry: { label: string; inverse: () => Promise<void> }) => registered.push(entry),
	}));
});

const { usePostboxFolderBulk } = await import('../usePostboxFolderBulk');

const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const inbox = { _id: 'f-inbox', role: 'inbox', unseenCount: 150, totalCount: 300 };
const trash = { _id: 'f-trash', role: 'trash', unseenCount: 0, totalCount: 7 };

describe('markAllRead', () => {
	it('walks every batch and registers one Undo for every id it flipped', async () => {
		const bulk = usePostboxFolderBulk(ref('mbx' as never));
		const [markBatch, setFlags] = runners;
		markBatch!
			.mockResolvedValueOnce({
				ok: true,
				result: { markedIds: ids('a', 100), ceilingUid: 500, afterUid: 320 },
			})
			.mockResolvedValueOnce({
				ok: true,
				result: { markedIds: ids('b', 50), ceilingUid: 500, afterUid: null },
			});

		await bulk.markAllRead(inbox);

		expect(markBatch!.mock.calls.map(([args]) => args)).toEqual([
			{ folderId: 'f-inbox' },
			{ folderId: 'f-inbox', ceilingUid: 500, afterUid: 320 },
		]);
		expect(registered).toHaveLength(1);

		await registered[0]!.inverse();
		const restored = setFlags!.mock.calls.map(([args]) => args);
		expect(restored.every((args) => args.seen === false)).toBe(true);
		expect(restored.map((args) => args.messageIds.length)).toEqual([100, 50]);
		expect(restored.flatMap((args) => args.messageIds)).toEqual([
			...ids('a', 100),
			...ids('b', 50),
		]);
	});

	it('does nothing for a folder with no unread mail, or for Drafts', async () => {
		const bulk = usePostboxFolderBulk(ref('mbx' as never));
		await bulk.markAllRead({ ...inbox, unseenCount: 0 });
		await bulk.markAllRead({ _id: 'f-drafts', role: 'drafts', unseenCount: 2, totalCount: 2 });
		expect(runners[0]).not.toHaveBeenCalled();
		expect(registered).toEqual([]);
	});

	it('offers to undo what a walk that failed halfway had already flipped', async () => {
		const bulk = usePostboxFolderBulk(ref('mbx' as never));
		runners[0]!
			.mockResolvedValueOnce({
				ok: true,
				result: { markedIds: ids('a', 3), ceilingUid: 9, afterUid: 3 },
			})
			.mockResolvedValueOnce({ ok: false });

		await bulk.markAllRead(inbox);

		expect(registered).toHaveLength(1);
		await registered[0]!.inverse();
		expect(runners[1]!.mock.calls[0]![0].messageIds).toEqual(ids('a', 3));
	});
});

describe('markRead', () => {
	const runnerOf = () => {
		const [markBatch, setFlags, empty, markCategoryBatch, markLabelBatch] = runners;
		return {
			markBatch: markBatch!,
			setFlags: setFlags!,
			empty: empty!,
			markCategoryBatch: markCategoryBatch!,
			markLabelBatch: markLabelBatch!,
		};
	};
	const undoIds = async (setFlags: ReturnType<typeof vi.fn>) => {
		setFlags.mockClear();
		await registered[0]!.inverse();
		const calls = setFlags.mock.calls.map(([args]) => args);
		expect(calls.every((args) => args.seen === false)).toBe(true);
		return calls.flatMap((args) => args.messageIds);
	};

	it("walks a label's batches by creation time and id, and undoes exactly what they flipped", async () => {
		const bulk = usePostboxFolderBulk(ref('mbx' as never));
		const { markLabelBatch, setFlags } = runnerOf();
		markLabelBatch
			.mockResolvedValueOnce({
				ok: true,
				result: { markedIds: ids('a', 4), ceilingTime: 900, afterTime: 400, afterId: 'r1' },
			})
			.mockResolvedValueOnce({
				ok: true,
				result: { markedIds: [], ceilingTime: 900, afterTime: 400, afterId: 'r2' },
			})
			.mockResolvedValueOnce({
				ok: true,
				result: { markedIds: ids('b', 2), ceilingTime: 900, afterTime: null, afterId: null },
			});

		await bulk.markRead({ kind: 'label', mailboxId: 'mbx' as never, labelId: 'lbl' as never });

		expect(markLabelBatch.mock.calls.map(([args]) => args)).toEqual([
			{ mailboxId: 'mbx', labelId: 'lbl' },
			{ mailboxId: 'mbx', labelId: 'lbl', ceilingTime: 900, afterTime: 400, afterId: 'r1' },
			{ mailboxId: 'mbx', labelId: 'lbl', ceilingTime: 900, afterTime: 400, afterId: 'r2' },
		]);
		expect(registered).toHaveLength(1);
		expect(await undoIds(setFlags)).toEqual([...ids('a', 4), ...ids('b', 2)]);
	});

	it("marks a folder's category through the category batch", async () => {
		const bulk = usePostboxFolderBulk(ref('mbx' as never));
		const { markBatch, markCategoryBatch, setFlags } = runnerOf();
		markCategoryBatch.mockResolvedValueOnce({
			ok: true,
			result: { markedIds: ids('n', 3), ceilingUid: 50, afterUid: null },
		});

		await bulk.markRead({ kind: 'category', folderId: 'f-inbox' as never, category: 'newsletter' });

		expect(markBatch).not.toHaveBeenCalled();
		expect(markCategoryBatch).toHaveBeenCalledWith({ folderId: 'f-inbox', category: 'newsletter' });
		expect(await undoIds(setFlags)).toEqual(ids('n', 3));
	});

	it("marks a bundle's own unread ids in move-sized chunks", async () => {
		const bulk = usePostboxFolderBulk(ref('mbx' as never));
		const { setFlags } = runnerOf();
		const bundle = ids('m', 250) as never[];
		setFlags.mockImplementation(async (args: { messageIds: string[] }) => ({
			ok: true,
			result: { seenChangedIds: args.messageIds },
		}));

		await bulk.markRead({ kind: 'messages', messageIds: bundle });

		const calls = setFlags.mock.calls.map(([args]) => args);
		expect(calls.every((args) => args.seen === true)).toBe(true);
		expect(calls.flatMap((args) => args.messageIds)).toEqual(bundle);
		expect(Math.max(...calls.map((args) => args.messageIds.length))).toBeLessThan(250);
		expect(await undoIds(setFlags)).toEqual(bundle);
	});

	it("undoes only the bundle's messages the server moved from unread to read", async () => {
		const bulk = usePostboxFolderBulk(ref('mbx' as never));
		const { setFlags } = runnerOf();
		// m1 was read on another client after the bundle row was drawn.
		setFlags.mockResolvedValueOnce({ ok: true, result: { seenChangedIds: ['m0', 'm2'] } });

		await bulk.markRead({ kind: 'messages', messageIds: ['m0', 'm1', 'm2'] as never[] });

		expect(registered).toHaveLength(1);
		expect(await undoIds(setFlags)).toEqual(['m0', 'm2']);
	});

	it('walks every mailbox folder of All inboxes and merges them into one Undo', async () => {
		const bulk = usePostboxFolderBulk(ref(null));
		const { markBatch, setFlags } = runnerOf();
		markBatch.mockImplementation(async (args: { folderId: string }) =>
			args.folderId === 'f-team'
				? { ok: false }
				: {
						ok: true,
						result: { markedIds: ids(`${args.folderId}-`, 2), ceilingUid: 9, afterUid: null },
					}
		);

		await bulk.markRead({ kind: 'folders', folderIds: ['f-own', 'f-team', 'f-other'] as never[] });

		expect(markBatch.mock.calls.map(([args]) => args.folderId)).toEqual([
			'f-own',
			'f-team',
			'f-other',
		]);
		expect(registered).toHaveLength(1);
		expect(await undoIds(setFlags)).toEqual([...ids('f-own-', 2), ...ids('f-other-', 2)]);
	});

	it('narrows every mailbox folder of All inboxes to one category', async () => {
		const bulk = usePostboxFolderBulk(ref(null));
		const { markBatch, markCategoryBatch } = runnerOf();
		markCategoryBatch.mockResolvedValue({
			ok: true,
			result: { markedIds: [], ceilingUid: 9, afterUid: null },
		});

		await bulk.markRead({
			kind: 'folders',
			folderIds: ['f-own', 'f-team'] as never[],
			category: 'newsletter',
		});

		expect(markBatch).not.toHaveBeenCalled();
		expect(markCategoryBatch.mock.calls.map(([args]) => args)).toEqual([
			{ folderId: 'f-own', category: 'newsletter' },
			{ folderId: 'f-team', category: 'newsletter' },
		]);
		expect(registered).toEqual([]);
	});
});

describe('emptying', () => {
	it('asks first, then empties the folder it asked about', async () => {
		const bulk = usePostboxFolderBulk(ref('mbx' as never));
		bulk.requestEmpty(trash);
		expect(bulk.pendingEmpty.value).toEqual({ folderId: 'f-trash', role: 'trash', count: 7 });
		expect(runners[2]).not.toHaveBeenCalled();

		await bulk.confirmEmpty();

		expect(runners[2]).toHaveBeenCalledWith({ folderId: 'f-trash' });
		expect(bulk.pendingEmpty.value).toBeNull();
	});

	it('is offered only for a non-empty Trash or Spam, and only to an owner', () => {
		const bulk = usePostboxFolderBulk(ref('mbx' as never));
		expect(bulk.canEmpty(trash)).toBe(true);
		expect(bulk.canEmpty({ ...trash, role: 'spam' })).toBe(true);
		expect(bulk.canEmpty({ ...trash, totalCount: 0 })).toBe(false);
		expect(bulk.canEmpty(inbox)).toBe(false);
		myRole.value = 'member';
		expect(bulk.canEmpty(trash)).toBe(false);
		bulk.requestEmpty(trash);
		expect(bulk.pendingEmpty.value).toBeNull();
	});
});
