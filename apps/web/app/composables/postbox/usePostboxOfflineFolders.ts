/**
 * Cold-start bridge between the offline folder cache and the live folder query
 * — the rail's sibling of {@link usePostboxOfflineThreads} (plan idea 49).
 *
 * Without it, a cold start (or a reconnect) renders an empty navigation rail
 * for as long as `listFolders` is pending: no inbox, no archive, no custom
 * folders, no unread counts. With the service worker in front, that window is
 * exactly when a returning offline visitor is looking at the app, so the rail
 * is served from the last-cached rows and handed back to the live rows the
 * instant they arrive — live always wins, replace-in-place.
 *
 * Every folder of a mailbox is cached (unlike threads, which cache two folder
 * roles): the rail is a few KB, and half a rail is worse than none.
 */

export function usePostboxOfflineFolders<T extends { _id: string }>(args: {
	/** Active mailbox id — namespaces the cache; null while none is selected. */
	mailboxId: Ref<string | null>;
	/** The live query rows (empty while pending). */
	liveFolders: Ref<readonly T[]>;
	/** True while the live query has not yet produced a result. */
	isLoading: Ref<boolean>;
}) {
	const cache = usePostboxOfflineCache(args.mailboxId);

	const cachedRows = ref<T[]>([]) as Ref<T[]>;
	/** When the served snapshot was persisted (ms); null when not from cache. */
	const cachedAt = ref<number | null>(null);

	/** (Re)load the cached rail for a mailbox, ignoring a stale in-flight load. */
	async function refreshCached(mailboxId: string | null) {
		cachedRows.value = [];
		cachedAt.value = null;
		if (!mailboxId) return;
		const rows = await cache.loadFolders<T>();
		const meta = await cache.loadFoldersMeta();
		// The mailbox may have changed while those reads were in flight; dropping
		// the result is the only way the rail never shows another account's names.
		if (args.mailboxId.value !== mailboxId) return;
		cachedRows.value = rows;
		cachedAt.value = meta?.savedAt ?? null;
	}

	watch(
		args.mailboxId,
		(mailboxId) => {
			void refreshCached(mailboxId);
		},
		{ immediate: true }
	);

	/** Rows to display: live once it has arrived, cached while still pending. */
	const rows = computed<T[]>(() => {
		if (!args.isLoading.value) return [...args.liveFolders.value];
		if (cachedRows.value.length > 0) return cachedRows.value;
		return [...args.liveFolders.value];
	});

	/** True when the rail is showing cached rows pending the live refresh. */
	const showingCached = computed(() => args.isLoading.value && cachedRows.value.length > 0);

	/** Persist the live rail once a result settles. */
	watch(
		() => (args.isLoading.value ? null : args.liveFolders.value),
		(live) => {
			// An empty result is never persisted: every mailbox has at least an
			// inbox, so `[]` here means "not really loaded", and writing it would
			// trade a usable cached rail for a blank one.
			if (live == null || live.length === 0) return;
			void cache.persistFolders(live).then(async () => {
				const meta = await cache.loadFoldersMeta();
				cachedAt.value = meta?.savedAt ?? cachedAt.value;
			});
		}
	);

	return { rows, showingCached, cachedAt: readonly(cachedAt) };
}
