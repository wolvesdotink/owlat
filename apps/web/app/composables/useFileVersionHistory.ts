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
 * Pagination is one explicit state, owned here:
 *
 *   idle            the list can grow when its end has a usable cursor;
 *   loadingOlder    one older read is in flight (a second request is refused);
 *   recovering      the server refused a cursor it issued (its
 *                   `version_history_cursor_rejected` reason, after the secret
 *                   was rotated): the older pages are gone, the newest page is
 *                   being refetched once, and no cursor is offered meanwhile;
 *   recoveryFailed  that refetch failed, or brought back a cursor already
 *                   refused; "Try again" refetches the newest page, never the
 *                   dead cursor.
 *
 * Only that reason enters recovery. Every other failure, including any other
 * `invalid_input`, keeps the ordinary error and retry. A page that says older
 * versions exist but brings no usable cursor (an instance without
 * INSTANCE_SECRET) shows as `olderUnavailable`, not as a complete list.
 * `historyRestarted` says the list started over; it stays until the next
 * successful older read or another file.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { FunctionReturnType } from 'convex/server';
import { extractOperationError } from '@owlat/shared/operationError';

type VersionPage = FunctionReturnType<typeof api.files.history.list>;
export type FileVersionRow = VersionPage['page'][number];

/** `data.reason` of a refused cursor (`files/history.ts` VERSION_HISTORY_CURSOR_REJECTED). */
const CURSOR_REJECTED = 'version_history_cursor_rejected';

export type VersionHistoryState = 'idle' | 'loadingOlder' | 'recovering' | 'recoveryFailed';

function isCursorRejection(error: unknown): boolean {
	const op = extractOperationError(error);
	return op?.category === 'invalid_input' && op.data?.['reason'] === CURSOR_REJECTED;
}

export function useFileVersionHistory(fileId: () => Id<'semanticFiles'>) {
	const {
		data: newest,
		error: newestError,
		isLoading: newestLoading,
		isRefetching: newestRefetching,
		refetch,
	} = useConvexQuery(api.files.history.list, () => ({ fileId: fileId() }));

	const state = ref<VersionHistoryState>('idle');
	const older = shallowRef<FileVersionRow[]>([]);
	/** Where the last older page ended; undefined until one has loaded. */
	const olderTail = shallowRef<Pick<VersionPage, 'isDone' | 'continueCursor'> | undefined>(
		undefined
	);
	const loadOlderFailed = ref(false);
	const historyRestarted = ref(false);
	/** Cursors of this file's history the server refused; never sent again. */
	const rejected = shallowRef<ReadonlySet<string>>(new Set());
	let requested = new Set<string>();
	let generation = 0;

	/** Drop the older pages and any older read in flight. */
	function resetOlder() {
		generation += 1;
		older.value = [];
		olderTail.value = undefined;
		loadOlderFailed.value = false;
		requested = new Set();
		if (state.value === 'loadingOlder') state.value = 'idle';
	}

	// Two primitive sources, compared one by one: a live update that leaves the
	// file and the end of the newest page where they were (a rename, a finished
	// extraction) keeps the older pages and any read in flight. Another file
	// clears everything, recovery included.
	watch([fileId, () => newest.value?.continueCursor ?? null], ([file], [previousFile]) => {
		resetOlder();
		if (file !== previousFile) {
			state.value = 'idle';
			historyRestarted.value = false;
			rejected.value = new Set();
		}
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
	/** The end's cursor, unless the server already refused it. */
	const tailCursor = computed<string | null>(() => {
		const cursor = tail.value?.continueCursor ?? null;
		return cursor !== null && rejected.value.has(cursor) ? null : cursor;
	});
	const isPaging = computed(() => state.value === 'idle' || state.value === 'loadingOlder');
	/** Older versions wait behind the list and can be asked for. */
	const hasOlder = computed(() => isPaging.value && tailCursor.value !== null);
	/** Older versions exist, but there is no way to read them. */
	const olderUnavailable = computed(
		() =>
			isPaging.value && tail.value !== undefined && !tail.value.isDone && tailCursor.value === null
	);
	/** The list is known not to be the whole history (or may not be, mid-recovery). */
	const isIncomplete = computed(
		() => (tail.value !== undefined && !tail.value.isDone) || !isPaging.value
	);

	/** Settle a recovery once the refetched newest page (or its failure) is in. */
	function settleRecovery() {
		if (state.value !== 'recovering') return;
		if (newestLoading.value || newestRefetching.value) return;
		const cursor = newest.value?.continueCursor ?? null;
		state.value =
			newestError.value || (cursor !== null && rejected.value.has(cursor))
				? 'recoveryFailed'
				: 'idle';
	}
	watch([newestLoading, newestRefetching, newestError], settleRecovery);

	function recover() {
		state.value = 'recovering';
		refetch();
		settleRecovery();
	}

	async function loadOlder() {
		const cursor = tailCursor.value;
		if (state.value !== 'idle' || cursor === null) return;
		const run = generation;
		state.value = 'loadingOlder';
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
			state.value = 'idle';
		} catch (error) {
			if (run !== generation) return;
			if (isCursorRejection(error)) {
				rejected.value = new Set([...rejected.value, cursor]);
				resetOlder();
				historyRestarted.value = true;
				recover();
				return;
			}
			loadOlderFailed.value = true;
			state.value = 'idle';
		}
	}

	/** "Try again" after a failed recovery: refetch the newest page. */
	function retryRecovery() {
		if (state.value === 'recoveryFailed') recover();
	}

	return {
		versions,
		state: readonly(state),
		hasOlder,
		olderUnavailable,
		isIncomplete,
		isLoadingOlder: computed(() => state.value === 'loadingOlder'),
		isRecovering: computed(() => state.value === 'recovering'),
		recoveryFailed: computed(() => state.value === 'recoveryFailed'),
		loadOlderFailed: readonly(loadOlderFailed),
		historyRestarted: readonly(historyRestarted),
		loadOlder,
		retryRecovery,
	};
}
