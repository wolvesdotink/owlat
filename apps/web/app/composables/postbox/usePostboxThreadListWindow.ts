/**
 * The flat thread list's windowed rendering and infinite scroll, in one place.
 *
 * Only folders above POSTBOX_VIRTUAL_THRESHOLD pay the windowing cost; small
 * folders keep the simple content-visibility path. Row height is a known
 * per-density constant, so this is fixed-height windowing with no dynamic
 * measurement.
 *
 * The list normally scrolls in its own box (`scrollEl`). A host that stacks it
 * inside a taller scroller (the Today column) hands that scroller in as
 * `scrollParent`: the window, the focus-follow and the auto-load then run
 * against the host, measured from where the list (`listEl`) starts inside it.
 * The per-folder scroll memory stays with the list's own box, so a hosted list
 * never overwrites the position the folder view restores.
 */
import { computed, ref, watch, type Ref } from 'vue';
import { POSTBOX_VIRTUAL_THRESHOLD } from '~/utils/postboxDensity';
import {
	usePostboxVirtualList,
	rememberScroll,
	useRememberedScroll,
} from './usePostboxVirtualList';
import { usePostboxListAutoLoad } from './usePostboxListAutoLoad';
import { usePostboxScrollEvent } from './usePostboxScrollHost';

export function usePostboxThreadListWindow<T>(opts: {
	rows: Ref<T[]>;
	rowHeight: Ref<number>;
	focusedIndex: Ref<number>;
	scrollParent: () => HTMLElement | null | undefined;
	/** The folder's role, or its id for a custom folder: keys the scroll memory. */
	folderKey: () => string;
	activeMessageId: () => string | null | undefined;
	hasMore: () => boolean;
	/** A page (first or "load more") is already in flight. */
	blocked: () => boolean;
	loadMore: () => void;
}) {
	const scrollEl = ref<HTMLElement | null>(null);
	const listEl = ref<HTMLElement | null>(null);
	const hostEl = computed(() => opts.scrollParent() ?? null);
	const scrollTarget = computed(() => hostEl.value ?? scrollEl.value);
	const itemCount = computed(() => opts.rows.value.length);
	const virtualize = computed(() => itemCount.value > POSTBOX_VIRTUAL_THRESHOLD);

	const { range, syncScroll, scrollToIndex } = usePostboxVirtualList({
		scrollEl: scrollTarget,
		listEl: computed(() => (hostEl.value ? listEl.value : null)),
		itemCount,
		rowHeight: opts.rowHeight,
		enabled: virtualize,
	});

	// Rows actually mounted: a bounded window when virtualizing, everything
	// otherwise. `windowStart` maps a windowed row back to its absolute index so
	// focus, selection and ARIA stay correct.
	const windowStart = computed(() => (virtualize.value ? range.value.startIndex : 0));
	const windowedRows = computed(() =>
		virtualize.value
			? opts.rows.value.slice(range.value.startIndex, range.value.endIndex)
			: opts.rows.value
	);

	// Keep the keyboard-focused row visible even when it is outside the mounted
	// window: shift the scroll (which re-derives the window and mounts the row);
	// usePostboxListKeyboard's own scrollIntoView then refines to "nearest".
	watch(opts.focusedIndex, (idx) => {
		if (idx < 0 || !virtualize.value) return;
		scrollToIndex(idx);
	});

	// Auto-grow the page as the window nears the end (replacing the manual "Load
	// more" click; the button stays as an always-available fallback), coalesced
	// to one derivation per animation frame.
	const folderScrollKey = computed(() => `postbox:scroll:${opts.folderKey()}`);
	const { handleScroll } = usePostboxListAutoLoad({
		scrollEl: scrollTarget,
		itemCount,
		hasMore: computed(opts.hasMore),
		blocked: computed(opts.blocked),
		onScroll: (el) => {
			syncScroll();
			if (!hostEl.value) rememberScroll(folderScrollKey.value, el.scrollTop);
		},
		loadMore: opts.loadMore,
	});
	// A hosted list's own box never scrolls; the host's scroll drives it.
	usePostboxScrollEvent(hostEl, handleScroll);

	// Restore the folder's last scroll position when the list mounts, when it
	// comes back from behind the reader (a `display: none` pane loses it), and
	// when the folder changes under the same list (top for an unseen folder).
	useRememberedScroll({
		scrollEl: computed(() => (hostEl.value ? null : scrollEl.value)),
		key: folderScrollKey,
		activeMessageId: opts.activeMessageId,
		onRestored: syncScroll,
	});

	return { scrollEl, listEl, virtualize, range, windowStart, windowedRows, handleScroll };
}
