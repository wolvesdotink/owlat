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
let refetch: ReturnType<typeof vi.fn>;

/** An Operation error as a backend call throws it. */
const operationError = (message: string, data?: Record<string, unknown>) =>
	Object.assign(new Error(message), {
		data: { category: 'invalid_input', message, ...(data ? { data } : {}) },
	});
/** What a refused cursor throws: `invalid_input` with its own reason. */
const invalidCursor = () =>
	operationError('Invalid version history cursor', {
		reason: 'version_history_cursor_rejected',
	});

beforeEach(() => {
	newest = shallowRef<Page | undefined>(undefined);
	calls = [];
	pending = [];
	// Recovery never forces a refetch: the newest page is live on its own.
	refetch = vi.fn();
	vi.stubGlobal('useConvexQuery', () => ({ data: newest, refetch }));
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

	it('keeps older pages and the read in flight across a live update that leaves the file and cursor alone', async () => {
		const { history } = setup();
		newest.value = page(['a'], 'b');
		await nextTick();
		const load = history.loadOlder();
		pending[0]!.resolve(page(['b'], 'c'));
		await load;

		// A rename arrives: a new page object with the same end.
		const renamed = page(['a'], 'b');
		renamed.page[0]!.filename = 'renamed.txt';
		newest.value = renamed;
		await nextTick();
		expect(ids(history.versions.value)).toEqual(['a', 'b']);
		expect(history.versions.value![0]!.filename).toBe('renamed.txt');
		expect(history.hasOlder.value).toBe(true);

		// And while the next older page is on its way.
		const inFlight = history.loadOlder();
		newest.value = page(['a'], 'b');
		await nextTick();
		expect(history.isLoadingOlder.value).toBe(true);
		pending[1]!.resolve(page(['c'], null));
		await inFlight;
		expect(ids(history.versions.value)).toEqual(['a', 'b', 'c']);
		expect(history.hasOlder.value).toBe(false);
		expect(history.isLoadingOlder.value).toBe(false);
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
		expect(history.historyRestarted.value).toBe(false);
		expect(refetch).not.toHaveBeenCalled();

		const retry = history.loadOlder();
		expect(history.loadOlderFailed.value).toBe(false);
		expect(calls[1]).toEqual({ fileId: 'f1', cursor: 'b' });
		pending[1]!.resolve(page(['b'], null));
		await retry;
		expect(ids(history.versions.value)).toEqual(['a', 'b']);
	});

	it('keeps the ordinary error and retry for an invalid_input that is not a refused cursor', async () => {
		const { history } = setup();
		newest.value = page(['a'], 'b');
		await nextTick();
		const first = history.loadOlder();
		pending[0]!.resolve(page(['b'], 'c'));
		await first;

		const failed = history.loadOlder();
		pending[1]!.reject(operationError('Invalid fileId'));
		await failed;
		expect(history.loadOlderFailed.value).toBe(true);
		expect(history.historyRestarted.value).toBe(false);
		// The older pages and their cursor stay; the retry resends it.
		expect(ids(history.versions.value)).toEqual(['a', 'b']);
		void history.loadOlder();
		expect(calls[2]).toEqual({ fileId: 'f1', cursor: 'c' });
		expect(refetch).not.toHaveBeenCalled();
	});

	it('starts again from the live newest page when the server refuses a cursor, with no extra request', async () => {
		const { history } = setup();
		newest.value = page(['a'], 'b');
		await nextTick();
		const first = history.loadOlder();
		pending[0]!.resolve(page(['b'], 'c'));
		await first;
		expect(ids(history.versions.value)).toEqual(['a', 'b']);

		const refused = history.loadOlder();
		pending[1]!.reject(invalidCursor());
		await refused;
		expect(ids(history.versions.value)).toEqual(['a']);
		expect(history.historyRestarted.value).toBe(true);
		expect(history.loadOlderFailed.value).toBe(false);
		expect(history.isLoadingOlder.value).toBe(false);
		expect(calls).toHaveLength(2);
		expect(refetch).not.toHaveBeenCalled();
		// The next click sends the live newest page's cursor, not the refused one.
		expect(history.hasOlder.value).toBe(true);
		void history.loadOlder();
		expect(calls[2]).toEqual({ fileId: 'f1', cursor: 'b' });
	});

	it('sends one request for a double click while a read is in flight', async () => {
		const { history } = setup();
		newest.value = page(['a'], 'b');
		await nextTick();
		const first = history.loadOlder();
		const second = history.loadOlder();
		expect(calls).toHaveLength(1);
		pending[0]!.reject(invalidCursor());
		await Promise.all([first, second]);
		expect(calls).toHaveLength(1);
	});

	it('resets again, once per click, when the same token is refused again', async () => {
		const { history } = setup();
		newest.value = page(['a'], 'b');
		await nextTick();
		for (let attempt = 0; attempt < 2; attempt++) {
			const refused = history.loadOlder();
			expect(calls[attempt]).toEqual({ fileId: 'f1', cursor: 'b' });
			pending[attempt]!.reject(invalidCursor());
			await refused;
			expect(ids(history.versions.value)).toEqual(['a']);
			expect(history.historyRestarted.value).toBe(true);
			expect(history.isLoadingOlder.value).toBe(false);
		}
		// Nothing retried on its own.
		await nextTick();
		expect(calls).toHaveLength(2);
		expect(refetch).not.toHaveBeenCalled();
	});

	it('loads normally from a fresh cursor on the live page after a refusal, and clears the notice', async () => {
		const { history } = setup();
		newest.value = page(['a'], 'b');
		await nextTick();
		const refused = history.loadOlder();
		pending[0]!.reject(invalidCursor());
		await refused;
		expect(history.historyRestarted.value).toBe(true);

		// The server recomputed the live page under the new secret.
		newest.value = page(['a'], 'b2');
		await nextTick();
		expect(history.historyRestarted.value).toBe(true);
		const next = history.loadOlder();
		expect(calls[1]).toEqual({ fileId: 'f1', cursor: 'b2' });
		pending[1]!.resolve(page(['b'], null));
		await next;
		expect(ids(history.versions.value)).toEqual(['a', 'b']);
		expect(history.historyRestarted.value).toBe(false);
		expect(history.hasOlder.value).toBe(false);
	});

	it('keeps the notice when the history is now complete, or cut short without a cursor', async () => {
		const { history } = setup();
		newest.value = page(['a'], 'b');
		await nextTick();
		const refused = history.loadOlder();
		pending[0]!.reject(invalidCursor());
		await refused;

		newest.value = page(['a'], null);
		await nextTick();
		expect(history.historyRestarted.value).toBe(true);
		expect(history.isIncomplete.value).toBe(false);
		expect(history.olderUnavailable.value).toBe(false);

		newest.value = { ...page(['a'], null), isDone: false };
		await nextTick();
		expect(history.historyRestarted.value).toBe(true);
		expect(history.isIncomplete.value).toBe(true);
		expect(history.olderUnavailable.value).toBe(true);
	});

	it('clears everything when the page moves to another file', async () => {
		const { fileId, history } = setup();
		newest.value = page(['a'], 'b');
		await nextTick();
		const first = history.loadOlder();
		pending[0]!.resolve(page(['b'], 'c'));
		await first;
		const refused = history.loadOlder();
		pending[1]!.reject(invalidCursor());
		await refused;
		const failed = history.loadOlder();
		pending[2]!.reject(new Error('network'));
		await failed;
		expect(history.loadOlderFailed.value).toBe(true);
		expect(history.historyRestarted.value).toBe(true);

		fileId.value = 'f2';
		newest.value = page(['x'], 'y');
		await nextTick();
		expect(history.historyRestarted.value).toBe(false);
		expect(history.loadOlderFailed.value).toBe(false);
		expect(ids(history.versions.value)).toEqual(['x']);
		void history.loadOlder();
		expect(calls[3]).toEqual({ fileId: 'f2', cursor: 'y' });
	});

	it('tells a history it cannot continue apart from a complete one', async () => {
		const { history } = setup();
		// More versions exist, but the page came without a cursor.
		newest.value = { ...page(['a'], null), isDone: false };
		await nextTick();
		expect(history.hasOlder.value).toBe(false);
		expect(history.olderUnavailable.value).toBe(true);

		newest.value = page(['a'], null);
		await nextTick();
		expect(history.olderUnavailable.value).toBe(false);

		// The same from an older page.
		newest.value = page(['a'], 'b');
		await nextTick();
		const load = history.loadOlder();
		pending[0]!.resolve({ ...page(['b'], null), isDone: false });
		await load;
		expect(ids(history.versions.value)).toEqual(['a', 'b']);
		expect(history.hasOlder.value).toBe(false);
		expect(history.olderUnavailable.value).toBe(true);
	});
});
