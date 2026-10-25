/**
 * Find in conversation (⌘F): one reader's query, its matches in order, the
 * active one, and stepping through them.
 *
 * The single owner of that state; PostboxThreadFindBar presents it, and the
 * cards read their own slice of it through the reader context (`findOf`). The
 * matches come from the reader's index (postboxFindIndex), so a word in a
 * collapsed message, a folded-away quote or an envelope whose body was never
 * loaded is found like one on screen. Stepping to a match expands its message
 * and asks its body to mark it and scroll to it, showing the quote for it if
 * that is where the match is. Earlier pages stay with the thread pager:
 * "Search earlier messages" asks it for one more page, and what arrives is
 * searched like the rest.
 *
 * The count is honest about what was searched: messages still being read,
 * bodies that could not be read and content that is not searched (encrypted
 * or signed mail) are reported beside it, never folded into a zero.
 *
 * The active match is an identity (message + occurrence), not a position, so
 * a reply arriving or a page loading shifts the counter without moving the
 * selection to another occurrence. Closing find clears every mark and hands
 * focus back to where it was; messages it expanded stay expanded.
 */
import { computed, onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue';
import { useKeyboardShortcuts } from '~/composables/useKeyboardShortcuts';
import { countPostboxFindMatches, postboxFindNeedle } from '~/utils/postboxFindHighlights';
import { POSTBOX_FIND_MAX_QUERY } from '~/utils/postboxFindSeed';
import {
	createPostboxFindIndex,
	defaultPostboxFindIndexDeps,
	type PostboxFindIndex,
	type PostboxFindRow,
} from './postboxFindIndex';

/** A search result opened in the reader: what was searched for, and in which message. */
export interface PostboxFindSeed {
	query: string;
	messageId: string;
}

/** One card's slice of the find state: what its body marks. */
export interface PostboxMessageFind {
	/** The normalized needle the body marks. */
	needle: string;
	/** The active match in this message (0-based), or null. */
	active: number | null;
	/** A match sits in the quoted chain, so the body shows the quote. */
	forceQuoted: boolean;
	/** Changes each time the active match should be scrolled to. */
	reveal: number;
}

interface FindHit {
	messageId: string;
	occurrence: number;
}

export function usePostboxThreadFind(source: {
	threadKey: () => string;
	/** The loaded conversation, oldest first. */
	messages: () => readonly PostboxFindRow[];
	/** False for a message whose body the reader does not show as an ordinary body. */
	searchable: (message: PostboxFindRow) => boolean;
	isExpanded: (messageId: string) => boolean;
	expand: (messageId: string) => void;
	pages: {
		hasEarlier: Readonly<Ref<boolean>>;
		loadingEarlier: Readonly<Ref<boolean>>;
		earlierFailed: Readonly<Ref<boolean>>;
		loadEarlier: () => void;
	};
	/** A search result this reader was opened on: open find with its words. */
	seed?: () => PostboxFindSeed | null | undefined;
	/** Whether this reader answers the find shortcut (the one on top). */
	answersShortcut?: () => boolean;
	/** Injected for tests; the reader's own wiring otherwise. */
	index?: PostboxFindIndex;
}) {
	const index = source.index ?? createPostboxFindIndex(defaultPostboxFindIndexDeps());

	const isOpen = ref(false);
	const query = ref('');
	/** Bumped when the bar should take focus and select its text. */
	const focusRequest = ref(0);
	const needle = computed(() => postboxFindNeedle(query.value));
	const active = shallowRef<FindHit | null>(null);
	const reveal = ref(0);
	/** The message a search result opened: its first match goes first. */
	const preferred = ref<string | null>(null);
	let returnFocus: HTMLElement | null = null;

	const searching = computed(() => isOpen.value && needle.value !== '');

	// Index what is loaded once there is something to look for, and what
	// arrives later (a reply, an earlier page) while find stays open.
	// The messages open on screen go first: their match is where find starts.
	watch(
		[searching, () => source.messages()],
		([on, rows]) => {
			if (!on) return;
			const open = rows.filter((row) => source.isExpanded(row._id));
			const folded = rows.filter((row) => !source.isExpanded(row._id));
			index.ensure([...open, ...folded], source.searchable);
		},
		{ immediate: true }
	);

	/** Per message: its matches, and how many sit above its quote. */
	const counts = computed(() => {
		const out = new Map<string, { total: number; fresh: number }>();
		if (!searching.value) return out;
		for (const row of source.messages()) {
			if (index.stateOf(row._id) !== 'ready') continue;
			const text = index.textOf(row._id);
			if (text) out.set(row._id, countPostboxFindMatches(text, needle.value));
		}
		return out;
	});

	const hits = computed<FindHit[]>(() => {
		const out: FindHit[] = [];
		for (const row of source.messages()) {
			const total = counts.value.get(row._id)?.total ?? 0;
			for (let occurrence = 0; occurrence < total; occurrence++) {
				out.push({ messageId: row._id, occurrence });
			}
		}
		return out;
	});

	const activeIndex = computed(() => {
		const current = active.value;
		if (!current) return -1;
		return hits.value.findIndex(
			(hit) => hit.messageId === current.messageId && hit.occurrence === current.occurrence
		);
	});

	/** Messages by where they stand, for the honest half of the count. */
	const coverage = computed(() => {
		let pending = 0;
		let failed = 0;
		let unsearchable = 0;
		if (searching.value) {
			for (const row of source.messages()) {
				const state = index.stateOf(row._id);
				if (state === 'failed') failed++;
				else if (state === 'unsearchable') unsearchable++;
				else if (state !== 'ready') pending++;
			}
		}
		return { pending, failed, unsearchable };
	});

	function select(hit: FindHit) {
		active.value = hit;
		if (!source.isExpanded(hit.messageId)) source.expand(hit.messageId);
		reveal.value++;
	}

	const isUnread = (id: string) => {
		const state = index.stateOf(id);
		return state === undefined || state === 'pending';
	};
	/** A message open on screen is still being read: its match would go first. */
	const onScreenUnread = computed(
		() =>
			searching.value &&
			source.messages().some((row) => source.isExpanded(row._id) && isUnread(row._id))
	);

	// Pick a match once there is one, and again when the active one is gone or
	// the query changed: the first one in a message already open on screen,
	// else the first one, so the pick never depends on which body loaded
	// first. A search result's message goes before both, so the reader waits
	// for that message to be read before it picks anything else.
	let pickedFor = needle.value;
	watch(
		[
			hits,
			needle,
			() => (preferred.value ? index.stateOf(preferred.value) : null),
			() => coverage.value.pending,
			onScreenUnread,
		],
		([list, current, preferredState, pending, waitForScreen]) => {
			if (current !== pickedFor) {
				pickedFor = current;
				active.value = null;
			}
			if (activeIndex.value !== -1) return;
			active.value = null;
			if (list.length === 0) return;
			if (preferred.value) {
				const unread = preferredState === undefined || preferredState === 'pending';
				if (unread && pending > 0) return;
				const id = preferred.value;
				preferred.value = null;
				const first = list.find((hit) => hit.messageId === id);
				if (first) {
					select(first);
					return;
				}
			}
			const onScreen = list.find((hit) => source.isExpanded(hit.messageId));
			if (onScreen) select(onScreen);
			else if (!waitForScreen) select(list[0]!);
		},
		{ immediate: true }
	);

	function step(delta: 1 | -1) {
		const list = hits.value;
		if (list.length === 0) return;
		const from = activeIndex.value;
		const next = from === -1 ? (delta === 1 ? 0 : list.length - 1) : from + delta;
		select(list[(next + list.length) % list.length]!);
	}

	function open(initial?: string, options: { focus?: boolean } = {}) {
		if (!isOpen.value && typeof document !== 'undefined') {
			const focused = document.activeElement;
			returnFocus = focused instanceof HTMLElement && focused !== document.body ? focused : null;
		}
		if (initial !== undefined) query.value = initial.slice(0, POSTBOX_FIND_MAX_QUERY);
		isOpen.value = true;
		if (options.focus !== false) focusRequest.value++;
	}

	/** Close the bar; focus goes back to where it was unless the reader moved on. */
	function close(options: { restoreFocus?: boolean } = {}) {
		if (!isOpen.value) return;
		isOpen.value = false;
		active.value = null;
		preferred.value = null;
		const target = returnFocus;
		returnFocus = null;
		if (options.restoreFocus !== false && target?.isConnected) {
			target.focus({ preventScroll: true });
		}
	}

	/** Try the bodies that could not be read once more. */
	function retry() {
		index.forgetFailed();
		if (searching.value) index.ensure(source.messages(), source.searchable);
	}

	// Another conversation in the same reader (Today's in-place advance):
	// nothing found in the last one applies, and answers still on their way
	// for it land nowhere.
	watch(source.threadKey, () => {
		close({ restoreFocus: false });
		index.reset();
	});
	onScopeDispose(() => index.reset());

	// A search result arrives highlighted, without taking the keyboard away
	// from the reader.
	if (source.seed) {
		watch(
			() => {
				const seed = source.seed?.();
				return seed?.query.trim() ? `${seed.messageId}\n${seed.query}` : null;
			},
			(key) => {
				const seed = source.seed?.();
				if (!key || !seed) return;
				preferred.value = seed.messageId;
				active.value = null;
				open(seed.query, { focus: false });
			},
			{ immediate: true }
		);
	}

	const { registerShortcut } = useKeyboardShortcuts();
	registerShortcut({
		id: 'global.findInConversation',
		handler: () => open(),
		when: () => source.answersShortcut?.() ?? true,
	});

	/** What one card's body marks; null when it has nothing to mark. */
	function findOf(messageId: string): PostboxMessageFind | null {
		if (!searching.value) return null;
		const count = counts.value.get(messageId);
		if (!count || count.total === 0) return null;
		const current = active.value?.messageId === messageId ? active.value : null;
		return {
			needle: needle.value,
			active: current ? current.occurrence : null,
			forceQuoted: count.total > count.fresh,
			reveal: current ? reveal.value : 0,
		};
	}

	/** How many matches a message holds (the collapsed row's count). */
	function matchCountOf(messageId: string): number {
		return searching.value ? (counts.value.get(messageId)?.total ?? 0) : 0;
	}

	return {
		isOpen,
		query,
		focusRequest,
		/** 0-based position of the active match, -1 for none. */
		activeIndex,
		total: computed(() => hits.value.length),
		hasQuery: computed(() => needle.value !== ''),
		coverage,
		hasEarlier: source.pages.hasEarlier,
		loadingEarlier: source.pages.loadingEarlier,
		earlierFailed: source.pages.earlierFailed,
		open,
		close,
		next: () => step(1),
		previous: () => step(-1),
		retry,
		searchEarlier: () => source.pages.loadEarlier(),
		findOf,
		matchCountOf,
	};
}

export type PostboxThreadFind = ReturnType<typeof usePostboxThreadFind>;
