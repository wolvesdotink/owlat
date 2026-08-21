/**
 * Triage filters for the Postbox list header — the one-tap All / Unread /
 * Starred / Attachments chips.
 *
 * The flags they filter on (`flagSeen`, `flagFlagged`, `hasAttachments`) are
 * already projected onto every list row, so filtering is client-side over the
 * fetched window: instant, offline-safe, and free — no extra queries. Before
 * this the only route to "show me unread" was typing `is:unread` into search.
 *
 * SCOPE, and why the counts are honest rather than exact: the window is the
 * pages loaded so far, NOT the folder. Counting folder-wide would need a server
 * aggregate, and there isn't a cheap one — Convex exposes no count aggregate
 * here, `mailMessages` is indexed on `flagSeen` but not on `flagFlagged` or
 * `hasAttachments` per folder, and a bounded counting scan would be a live
 * subscription that re-runs on EVERY write to the folder (marking one message
 * read would re-scan the window). So the counts stay window-scoped and say so:
 * `countsArePartial` is true while more pages exist, and the chips render "12+"
 * rather than a precise "12" that is really "12 of what happens to be loaded".
 * Infinite scroll keeps growing the window, so the numbers converge as the user
 * scrolls. `mailFolders.unseenCount` is exact and maintained, but using it for
 * the Unread chip alone would put an exact badge on a filter that only searches
 * the window — a worse lie than an honest "+".
 *
 * The active chip persists per (mailbox, folder) in localStorage, mirroring how
 * the folder rail's collapsed state and the Team Inbox's sort persist — a
 * folder remembers how you left it. Counts always reflect the UNFILTERED rows,
 * so a chip never hides its own badge.
 */

export type PostboxTriageFilter = 'all' | 'unread' | 'starred' | 'attachments';

const FILTERS: PostboxTriageFilter[] = ['all', 'unread', 'starred', 'attachments'];

function isTriageFilter(value: unknown): value is PostboxTriageFilter {
	return typeof value === 'string' && (FILTERS as string[]).includes(value);
}

/** Rows the chips filter on — the projection PostboxThreadRow already receives. */
interface TriageFilterableRow {
	flagSeen: boolean;
	flagFlagged: boolean;
	hasAttachments: boolean;
}

export function usePostboxTriageFilters<T extends TriageFilterableRow>(args: {
	/** Persistence scope: `<mailboxId>:<folderKey>` so each folder remembers. */
	scope: Ref<string>;
	rows: Ref<T[]>;
	/** True while pages remain unloaded — makes the counts a lower bound. */
	hasMore?: Ref<boolean>;
}) {
	const STORAGE_PREFIX = 'owlat:postbox:triage-filter:';

	const active = ref<PostboxTriageFilter>('all');

	// Hydrate once per scope change; an absent/corrupt value falls back to 'all'.
	// Client-only: the server render always starts at 'all' (matching
	// useLocalStorage's SSR posture) and hydrates to the stored chip on mount.
	watch(
		args.scope,
		(scope) => {
			if (!import.meta.client) return;
			const stored = localStorage.getItem(STORAGE_PREFIX + scope);
			active.value = isTriageFilter(stored) ? stored : 'all';
		},
		{ immediate: true }
	);

	function setFilter(next: PostboxTriageFilter) {
		active.value = next;
		if (!import.meta.client) return;
		try {
			localStorage.setItem(STORAGE_PREFIX + args.scope.value, next);
		} catch {
			// A blocked localStorage must not break triage — the chip still works
			// for the session, it just won't survive a reload.
		}
	}

	const counts = computed(() => {
		const rows = args.rows.value;
		let unread = 0;
		let starred = 0;
		let attachments = 0;
		for (const row of rows) {
			if (!row.flagSeen) unread++;
			if (row.flagFlagged) starred++;
			if (row.hasAttachments) attachments++;
		}
		return { all: rows.length, unread, starred, attachments };
	});

	const filtered = computed(() => {
		switch (active.value) {
			case 'unread':
				return args.rows.value.filter((row) => !row.flagSeen);
			case 'starred':
				return args.rows.value.filter((row) => row.flagFlagged);
			case 'attachments':
				return args.rows.value.filter((row) => row.hasAttachments);
			default:
				return args.rows.value;
		}
	});

	/** The counts are a lower bound: unloaded pages may hold more of each. */
	const countsArePartial = computed(() => args.hasMore?.value ?? false);

	return { active, setFilter, counts, countsArePartial, filtered };
}
