/**
 * usePostboxFolderBulk: "Mark all as read" walks the folder batch by batch and
 * its Undo puts back exactly the messages it flipped; "Empty" asks first and is
 * only offered to someone the server would let do it.
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
	// Created in order: the mark-read batch, setFlags (Undo), emptyFolder.
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
