/**
 * The file detail page's version history, read a page at a time
 * (`files.history.list`). The newest page is live; older pages are appended
 * on request, one read at a time, and a read that completes after the page
 * moved on is dropped rather than appended to the wrong list.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { nextTick, ref, shallowRef } from 'vue';
import { useFileVersionHistory } from '../useFileVersionHistory';

interface Row {
	_id: string;
	filename: string;
	fileSize: number;
	version: number;
	createdAt: number;
	url: string | null;
}
interface Page {
	page: Row[];
	isDone: boolean;
	continueCursor: string | null;
}

const row = (id: string, version: number): Row => ({
	_id: id,
	filename: `${id}.txt`,
	fileSize: 10,
	version,
	createdAt: version,
	url: null,
});
const page = (ids: string[], continueCursor: string | null): Page => ({
	page: ids.map((id, i) => row(id, 100 - i)),
	isDone: continueCursor === null,
	continueCursor,
});

let newest: ReturnType<typeof shallowRef<Page | undefined>>;
let calls: Array<{ fileId: string; cursor: string }>;
let pending: Array<{ resolve: (value: Page) => void; reject: (error: Error) => void }>;

beforeEach(() => {
	newest = shallowRef<Page | undefined>(undefined);
	calls = [];
	pending = [];
	vi.stubGlobal('useConvexQuery', () => ({ data: newest }));
	vi.stubGlobal('requireConvex', () => ({
		query: (_ref: unknown, args: { fileId: string; cursor: string }) => {
			calls.push(args);
			return new Promise<Page>((resolve, reject) => pending.push({ resolve, reject }));
		},
	}));
});

function setup(initialFileId = 'f1') {
	const fileId = ref(initialFileId);
	const history = useFileVersionHistory(() => fileId.value as never);
	return { fileId, history };
}

const ids = (rows: Array<{ _id: string }> | undefined) => rows?.map((r) => r._id);

describe('useFileVersionHistory', () => {
	it('shows the newest page, then appends older pages until the chain is done', async () => {
		const { history } = setup();
		expect(history.versions.value).toBeUndefined();
		expect(history.hasOlder.value).toBe(false);

		newest.value = page(['a', 'b'], 'c');
		await nextTick();
		expect(ids(history.versions.value)).toEqual(['a', 'b']);
		expect(history.hasOlder.value).toBe(true);

		const first = history.loadOlder();
		expect(calls).toEqual([{ fileId: 'f1', cursor: 'c' }]);
		expect(history.isLoadingOlder.value).toBe(true);
		pending[0]!.resolve(page(['c', 'd'], 'e'));
		await first;
		expect(ids(history.versions.value)).toEqual(['a', 'b', 'c', 'd']);
		expect(history.hasOlder.value).toBe(true);
		expect(history.isLoadingOlder.value).toBe(false);

		const second = history.loadOlder();
		expect(calls[1]).toEqual({ fileId: 'f1', cursor: 'e' });
		pending[1]!.resolve(page(['e'], null));
		await second;
		expect(ids(history.versions.value)).toEqual(['a', 'b', 'c', 'd', 'e']);
		expect(history.hasOlder.value).toBe(false);

		await history.loadOlder();
		expect(calls).toHaveLength(2);
	});

	it('runs one older read at a time', async () => {
		const { history } = setup();
		newest.value = page(['a'], 'b');
		await nextTick();

		const first = history.loadOlder();
		void history.loadOlder();
		expect(calls).toHaveLength(1);
		pending[0]!.resolve(page(['b'], null));
		await first;
	});

	it('drops an older page that lands after the page moved to another file', async () => {
		const { fileId, history } = setup();
		newest.value = page(['a'], 'b');
		await nextTick();

		const stale = history.loadOlder();
		fileId.value = 'f2';
		newest.value = page(['x'], 'y');
		await nextTick();
		expect(history.isLoadingOlder.value).toBe(false);

		pending[0]!.resolve(page(['b'], null));
		await stale;
		expect(ids(history.versions.value)).toEqual(['x']);
		// The new file's history continues from its own cursor.
		expect(history.hasOlder.value).toBe(true);
		void history.loadOlder();
		expect(calls[1]).toEqual({ fileId: 'f2', cursor: 'y' });
	});

	it('starts over when the newest page ends somewhere else', async () => {
		const { history } = setup();
		newest.value = page(['a'], 'b');
		await nextTick();
		const load = history.loadOlder();
		pending[0]!.resolve(page(['b'], 'c'));
		await load;
		expect(ids(history.versions.value)).toEqual(['a', 'b']);

		// A version was deleted: the live page now ends earlier.
		newest.value = page(['a'], null);
		await nextTick();
		expect(ids(history.versions.value)).toEqual(['a']);
		expect(history.hasOlder.value).toBe(false);
	});

	it('stops when a stored chain loops back across pages', async () => {
		const { history } = setup();
		newest.value = page(['a'], 'b');
		await nextTick();

		// The walk from `b` comes back round to the first cursor.
		const load = history.loadOlder();
		pending[0]!.resolve(page(['b'], 'b'));
		await load;
		expect(history.hasOlder.value).toBe(false);
	});

	it('stops when an older page repeats a version already shown', async () => {
		const { history } = setup();
		newest.value = page(['a'], 'b');
		await nextTick();

		const load = history.loadOlder();
		pending[0]!.resolve(page(['b', 'a'], 'z'));
		await load;
		expect(ids(history.versions.value)).toEqual(['a', 'b']);
		expect(history.hasOlder.value).toBe(false);
	});

	it('keeps the cursor after a failed read so it can be tried again', async () => {
		const { history } = setup();
		newest.value = page(['a'], 'b');
		await nextTick();

		const failed = history.loadOlder();
		pending[0]!.reject(new Error('network'));
		await failed;
		expect(history.loadOlderFailed.value).toBe(true);
		expect(history.hasOlder.value).toBe(true);

		const retry = history.loadOlder();
		expect(history.loadOlderFailed.value).toBe(false);
		expect(calls[1]).toEqual({ fileId: 'f1', cursor: 'b' });
		pending[1]!.resolve(page(['b'], null));
		await retry;
		expect(ids(history.versions.value)).toEqual(['a', 'b']);
	});
});
