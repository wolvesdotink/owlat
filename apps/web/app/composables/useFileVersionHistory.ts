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
 *
 * A cursor the server refuses (its `version_history_cursor_rejected` reason,
 * for instance after INSTANCE_SECRET was rotated) cannot continue this list,
 * so the older pages are dropped and the list starts again from the live
 * newest page, with `historyRestarted` saying so. Nothing is refetched: the
 * newest page is a live subscription the server recomputes, cursor included,
 * when its inputs change. "Show older versions" then sends whatever cursor
 * that page carries; if the server refuses it again, the same reset happens
 * again, one request per click. Every other failure, including any other
 * `invalid_input`, keeps the ordinary error and retry.
 *
 * A page that says older versions exist but brings no cursor (an instance
 * without INSTANCE_SECRET) shows as `olderUnavailable`, not as a complete
 * list. `historyRestarted` stays until the next successful older read or
 * another file.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { FunctionReturnType } from 'convex/server';
import { extractOperationError } from '@owlat/shared/operationError';

type VersionPage = FunctionReturnType<typeof api.files.history.list>;
export type FileVersionRow = VersionPage['page'][number];

/** `data.reason` of a refused cursor (`files/history.ts` VERSION_HISTORY_CURSOR_REJECTED). */
const CURSOR_REJECTED = 'version_history_cursor_rejected';

function isCursorRejection(error: unknown): boolean {
	const op = extractOperationError(error);
	return op?.category === 'invalid_input' && op.data?.['reason'] === CURSOR_REJECTED;
}

export function useFileVersionHistory(fileId: () => Id<'semanticFiles'>) {
	const { data: newest } = useConvexQuery(api.files.history.list, () => ({ fileId: fileId() }));

	const older = shallowRef<FileVersionRow[]>([]);
	/** Where the last older page ended; undefined until one has loaded. */
	const olderTail = shallowRef<Pick<VersionPage, 'isDone' | 'continueCursor'> | undefined>(
		undefined
	);
	const isLoadingOlder = ref(false);
	const loadOlderFailed = ref(false);
	/** The server refused a cursor, so the list started again from the newest page. */
	const historyRestarted = ref(false);
	let requested = new Set<string>();
	let generation = 0;

	/** Drop the older pages, their cursors and any older read in flight. */
	function resetOlder() {
		generation += 1;
		older.value = [];
		olderTail.value = undefined;
		isLoadingOlder.value = false;
		loadOlderFailed.value = false;
		requested = new Set();
	}

	// Two primitive sources, compared one by one: a live update that leaves the
	// file and the end of the newest page where they were (a rename, a finished
	// extraction) keeps the older pages and any read in flight. Another file
	// clears the notice too.
	watch([fileId, () => newest.value?.continueCursor ?? null], ([file], [previousFile]) => {
		resetOlder();
		if (file !== previousFile) historyRestarted.value = false;
	});

	/** Every version read so far, newest first; undefined until the first page lands. */
	const versions = computed<FileVersionRow[] | undefined>(() => {
		const head = newest.value?.page;
		if (!head) return undefined;
		if (older.value.length === 0) return head;
		const shown = new Set(head.map((row) => row._id));
		return [...head, ...older.value.filter((row) => !shown.has(row._id))];
	});

	/** How the list read so far ends. */
	const tail = computed(() => olderTail.value ?? newest.value);
	const nextCursor = computed<string | null>(() => tail.value?.continueCursor ?? null);
	const hasOlder = computed(() => nextCursor.value !== null);
	/** Older versions exist, but the server gave no way to read them. */
	const olderUnavailable = computed(
		() => tail.value !== undefined && !tail.value.isDone && tail.value.continueCursor === null
	);
	/** The list is not the whole history. */
	const isIncomplete = computed(() => tail.value !== undefined && !tail.value.isDone);

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
			olderTail.value =
				repeated || (next !== null && requested.has(next))
					? { isDone: true, continueCursor: null }
					: { isDone: result.isDone, continueCursor: next };
			historyRestarted.value = false;
		} catch (error) {
			if (run !== generation) return;
			if (isCursorRejection(error)) {
				// This cursor cannot continue the list: start again from the live
				// newest page, whose cursor is the next one a click sends.
				resetOlder();
				historyRestarted.value = true;
				return;
			}
			loadOlderFailed.value = true;
		} finally {
			if (run === generation) isLoadingOlder.value = false;
		}
	}

	return {
		versions,
		hasOlder,
		olderUnavailable,
		isIncomplete,
		isLoadingOlder: readonly(isLoadingOlder),
		loadOlderFailed: readonly(loadOlderFailed),
		historyRestarted: readonly(historyRestarted),
		loadOlder,
	};
}
