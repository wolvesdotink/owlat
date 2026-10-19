/**
 * A file's version history on its detail page, read a page at a time from
 * `files.history.list`.
 *
 * The newest page is a live subscription, so a new upload or a renamed version
 * shows at once. Older pages are one-shot reads appended on request ("Show
 * older versions"): one runs at a time, and a read that lands after the page
 * moved to another file, or after the newest page's end moved, is dropped
 * instead of being appended to a list it no longer continues.
 *
 * The server stops a walk at a row it already visited within one call; a
 * stored chain that loops back across pages is caught here, when a cursor or a
 * row comes round a second time.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { FunctionReturnType } from 'convex/server';

type VersionPage = FunctionReturnType<typeof api.files.history.list>;
export type FileVersionRow = VersionPage['page'][number];

export function useFileVersionHistory(fileId: () => Id<'semanticFiles'>) {
	const { data: newest } = useConvexQuery(api.files.history.list, () => ({ fileId: fileId() }));

	const older = shallowRef<FileVersionRow[]>([]);
	/** Where the next older page starts; undefined until one has loaded. */
	const olderCursor = ref<string | null | undefined>(undefined);
	const isLoadingOlder = ref(false);
	const loadOlderFailed = ref(false);
	let requested = new Set<string>();
	let generation = 0;

	watch(
		() => [fileId(), newest.value?.continueCursor ?? null] as const,
		() => {
			generation += 1;
			older.value = [];
			olderCursor.value = undefined;
			isLoadingOlder.value = false;
			loadOlderFailed.value = false;
			requested = new Set();
		}
	);

	/** Every version read so far, newest first; undefined until the first page lands. */
	const versions = computed<FileVersionRow[] | undefined>(() => {
		const head = newest.value?.page;
		if (!head) return undefined;
		if (older.value.length === 0) return head;
		const shown = new Set(head.map((row) => row._id));
		return [...head, ...older.value.filter((row) => !shown.has(row._id))];
	});

	const nextCursor = computed<string | null>(() => {
		if (!newest.value) return null;
		return olderCursor.value === undefined ? newest.value.continueCursor : olderCursor.value;
	});
	const hasOlder = computed(() => nextCursor.value !== null);

	async function loadOlder() {
		const cursor = nextCursor.value;
		if (isLoadingOlder.value || cursor === null) return;
		const run = generation;
		isLoadingOlder.value = true;
		loadOlderFailed.value = false;
		try {
			const result = await requireConvex().query(api.files.history.list, {
				fileId: fileId(),
				cursor,
			});
			if (run !== generation) return;
			requested.add(cursor);
			const shown = new Set((versions.value ?? []).map((row) => row._id));
			const repeated = result.page.some((row) => shown.has(row._id));
			older.value = [...older.value, ...result.page.filter((row) => !shown.has(row._id))];
			const next = result.continueCursor;
			olderCursor.value = repeated || (next !== null && requested.has(next)) ? null : next;
		} catch {
			if (run === generation) loadOlderFailed.value = true;
		} finally {
			if (run === generation) isLoadingOlder.value = false;
		}
	}

	return {
		versions,
		hasOlder,
		isLoadingOlder: readonly(isLoadingOlder),
		loadOlderFailed: readonly(loadOlderFailed),
		loadOlder,
	};
}
