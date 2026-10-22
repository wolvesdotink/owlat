/**
 * The jump-back store: which records this person opened last, kept in
 * `localStorage` per user and organization (`~/lib/commandPaletteObjectRecents`
 * holds the rules), plus which of them are on screen right now.
 *
 * Module state, shared by every surface that records an open and by the palette
 * that lists them: an open recorded on the campaign page must be in the list the
 * palette shows a second later, without a round trip through storage.
 *
 * Every storage access is guarded: `localStorage` throws in a private-mode or
 * quota-exhausted browser, and the list is a convenience — it just stays empty.
 */
import { computed, onBeforeUnmount, shallowRef, watch } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import type { PaletteItem } from '~/lib/commandPalette';
import {
	PALETTE_OBJECT_ICONS,
	type PaletteObjectRecent,
	jumpBackEntries,
	objectRecencyIndex,
	objectRecentKey,
	objectRecentsStorageKey,
	parseObjectRecents,
	pushObjectRecent,
} from '~/lib/commandPaletteObjectRecents';

/**
 * An open as a surface reports it; the store stamps the time. `href` defaults to
 * the page's own path, which is right for every detail page; a surface that is
 * not its record's route (a reader inside an overlay) names the route.
 */
export type PaletteObjectOpen = Omit<PaletteObjectRecent, 'openedAt' | 'href'> & { href?: string };

const entries = shallowRef<readonly PaletteObjectRecent[]>([]);
/** Records on screen now, with how many mounted surfaces show each. */
const onScreen = shallowRef<ReadonlyMap<string, number>>(new Map());

function readStore(key: string | null) {
	if (!key) {
		entries.value = [];
		return;
	}
	try {
		entries.value = parseObjectRecents(localStorage.getItem(key));
	} catch {
		entries.value = [];
	}
}

function adjustOnScreen(key: string, delta: 1 | -1) {
	const next = new Map(onScreen.value);
	const count = (next.get(key) ?? 0) + delta;
	if (count > 0) next.set(key, count);
	else next.delete(key);
	onScreen.value = next;
}

function useObjectRecentsKey() {
	const { user, currentSession, activeOrganizationId } = useAuth();
	return computed(() => {
		// The session names its user even before the user record is filled in.
		const userId = user.value?.id ?? currentSession?.value?.userId;
		return userId ? objectRecentsStorageKey(userId, activeOrganizationId.value) : null;
	});
}

/**
 * Record that the calling surface has `source()` open, for as long as it is
 * mounted. Re-records when the record, its title or its route changes (a title
 * that loads after the page, a reader that moves to the next conversation), and
 * marks it on screen so the jump-back list skips it while you are looking at it.
 */
export function useRecordPaletteObjectOpen(source: () => PaletteObjectOpen | null): void {
	const storageKey = useObjectRecentsKey();
	// The path the surface was mounted on, read once: the route changes before a
	// page that is being left unmounts, and a re-record in that gap must not
	// file the record under the page being navigated TO.
	const ownPath = useRoute().path;
	let shownKey: string | null = null;

	function show(key: string | null) {
		if (key === shownKey) return;
		if (shownKey) adjustOnScreen(shownKey, -1);
		if (key) adjustOnScreen(key, 1);
		shownKey = key;
	}

	watch(
		() => {
			const reported = source();
			if (!reported || !reported.id || !reported.title.trim()) return null;
			const open = { ...reported, href: reported.href ?? ownPath };
			// Whether there is anyone to record for is part of it: an open seen
			// before the session resolved is recorded the moment it does. Not the
			// key itself — an organization switch must not file this record under
			// the organization switched to.
			const ready = storageKey.value !== null;
			const signature = [objectRecentKey(open), open.title, open.href, String(ready)];
			return { open, signature: signature.join('\n') };
		},
		(next, previous) => {
			if (import.meta.server) return;
			show(next ? objectRecentKey(next.open) : null);
			if (!next || next.signature === previous?.signature) return;
			// Re-read first: another tab may have recorded since, and writing this
			// tab's older copy back would drop its records.
			const key = storageKey.value;
			readStore(key);
			if (!key) return;
			entries.value = pushObjectRecent(entries.value, { ...next.open, openedAt: Date.now() });
			try {
				localStorage.setItem(key, JSON.stringify(entries.value));
			} catch {
				// Quota or disabled storage — the list is a convenience, not state.
			}
		},
		{ immediate: true }
	);
	onBeforeUnmount(() => show(null));
}

/**
 * The palette's side: the jump-back rows, and how recently each record was
 * opened for the ranking tie-break. `load` re-reads storage (the palette calls
 * it on every open, so a record opened in another tab shows up too).
 */
export function useCommandPaletteObjectRecents() {
	const { t } = useI18n();
	const storageKey = useObjectRecentsKey();
	const { setActiveMailboxId } = usePostboxActiveMailbox();

	function load() {
		if (import.meta.server) return;
		readStore(storageKey.value);
	}

	/** Reopen a record; a conversation first selects the mailbox it lives in. */
	function reopen(entry: PaletteObjectRecent) {
		if (entry.mailboxId) setActiveMailboxId(entry.mailboxId as Id<'mailboxes'>);
		void navigateTo(entry.href);
	}

	/** The rows of the idle palette's "Jump back" group, newest first. */
	const jumpBackItems = computed<PaletteItem[]>(() =>
		jumpBackEntries(entries.value, new Set(onScreen.value.keys())).map((entry) => ({
			id: `jump:${objectRecentKey(entry)}`,
			label: entry.title,
			subtitle: t(`shared.commandPaletteObjectRecents.kinds.${entry.kind}`),
			icon: PALETTE_OBJECT_ICONS[entry.kind],
			objectId: entry.id,
			run: () => reopen(entry),
		}))
	);

	const recency = computed(() => objectRecencyIndex(entries.value));
	function recencyOf(objectId: string): number | undefined {
		return recency.value.get(objectId);
	}

	return { load, jumpBackItems, recencyOf };
}
