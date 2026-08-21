/**
 * Cold-start bridge between the offline read cache and the live thread query.
 *
 * On a cold start (or a reconnect) the live Convex query is momentarily pending.
 * Rather than show a blank list, this composable serves the last-cached rows for
 * the folder IMMEDIATELY, marks them stale (the header shows a subtle
 * "updating…" shimmer), and hands back to the live rows the instant they arrive
 * — replace-in-place, live always wins. It also persists the newest rows back to
 * the cache whenever a fresh live result settles, and exposes WHEN the cache
 * was written so the offline banner can date itself ("cached at 14:32").
 *
 * Cached folders: inbox + snoozed (the two surfaces people open on flaky
 * connections — snoozed mail is exactly what you check without network).
 * Every other folder is a transparent pass-through of the live rows.
 *
 * Starred needs no cache key of its own: it is not a folder role (there is no
 * `starred` mailFolders row to list), but the triage chip over `flagFlagged`
 * rows — and those rows are already inside the cached inbox/snoozed windows.
 * The chips run client-side over `rows` below, so a starred slice of cached
 * mail works offline by construction.
 */

import { reconcileThreadRows } from '~/utils/postboxOfflineStore';

/** Folder roles whose rows participate in the offline cache. */
const CACHEABLE_FOLDERS = new Set(['inbox', 'snoozed']);

export function usePostboxOfflineThreads<T extends { _id: string }>(args: {
	/** Active mailbox id — namespaces the cache so mailbox A's rows never reach B. */
	mailboxId: Ref<string>;
	folderRole: Ref<string>;
	/** The live query rows (empty while pending). */
	liveRows: Ref<readonly T[]>;
	/** True while the live query has not yet produced a result. */
	isLoading: Ref<boolean>;
	/**
	 * True while the query is re-subscribing with `keepPreviousData` — the rows
	 * on hand are the PREVIOUS folder's. Distinct from `isLoading` (which is
	 * false in that window) and load-bearing for persistence: writing those rows
	 * under the incoming folder's key would poison its cache.
	 */
	isRefetching?: Ref<boolean>;
}) {
	const cache = usePostboxOfflineCache(args.mailboxId);

	const cacheable = computed(() => CACHEABLE_FOLDERS.has(args.folderRole.value));

	const cachedRows = ref<T[]>([]) as Ref<T[]>;
	const loadedFolder = ref<string | null>(null);
	/** When the served cache snapshot was persisted (ms); null if not from cache. */
	const cachedAt = ref<number | null>(null);

	/** (Re)load cached rows when the folder changes to a cacheable one. */
	async function refreshCached(folder: string) {
		// Drop the outgoing folder's snapshot before the await: `rows` serves
		// `cachedRows` while pending, so leaving them in place would render the
		// previous folder's cached mail under the new folder's header.
		cachedRows.value = [];
		cachedAt.value = null;
		if (!cacheable.value) {
			loadedFolder.value = folder;
			return;
		}
		cachedRows.value = await cache.loadThreads<T>(folder);
		const meta = await cache.loadThreadsMeta(folder);
		cachedAt.value = meta?.savedAt ?? null;
		loadedFolder.value = folder;
	}

	// Reload cached rows when the folder OR the mailbox changes, so switching
	// accounts never leaves the previous mailbox's rows on screen.
	watch(
		[args.folderRole, args.mailboxId],
		([folder]) => {
			void refreshCached(folder);
		},
		{ immediate: true }
	);

	/**
	 * No live result for THIS folder yet: either the first load (`isLoading`) or
	 * a re-subscribe still showing the previous folder's rows (`isRefetching`).
	 * Both are windows where the cache, not `liveRows`, is the honest source.
	 */
	const pending = computed(() => args.isLoading.value || (args.isRefetching?.value ?? false));

	/** Rows to display: live once it has arrived, cached while still pending. */
	const rows = computed<T[]>(() => {
		if (!pending.value) return reconcileThreadRows<T>([], args.liveRows.value);
		if (cacheable.value && cachedRows.value.length > 0) return cachedRows.value;
		return [...args.liveRows.value];
	});

	/** True when the list is showing cached rows pending the live refresh. */
	const showingCached = computed(
		() => pending.value && cacheable.value && cachedRows.value.length > 0
	);

	/** Persist the newest live rows back to the cache once a result settles. */
	watch(
		() => (pending.value ? null : args.liveRows.value),
		(live) => {
			if (live == null || !cacheable.value) return;
			void cache.persistThreads(args.folderRole.value, live).then(() => {
				void cache.loadThreadsMeta(args.folderRole.value).then((meta) => {
					cachedAt.value = meta?.savedAt ?? cachedAt.value;
				});
			});
		}
	);

	return { rows, showingCached, isOffline: cache.isOffline, cachedAt: readonly(cachedAt) };
}
