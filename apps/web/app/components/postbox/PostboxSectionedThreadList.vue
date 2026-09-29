<script setup lang="ts" generic="T extends { _id: string }">
/**
 * The sectioned Postbox list: ordered, collapsible sections with sticky
 * headers, one keyboard order across every expanded section, and a
 * section-aware render window for large lists.
 *
 * The categories view (PostboxThreadCategoryList) and the split inbox
 * (PostboxThreadSectionList) are thin adapters over this shell: they map their
 * grouping onto `sections` and render their own row through the `#row` slot.
 * Keyboard navigation, windowing, the sticky headers and the spacer rows live
 * here once, so a fix to any of them reaches both views.
 *
 * Paging is the adapter's choice. Pass `hasMore` to get near-bottom auto-load
 * plus a fallback button for the whole list (categories). Leave it unset and
 * use `#section-footer` with `canLoadMore` for per-section paging (sections):
 * a scroll near the bottom cannot say which section the reader meant, so that
 * list gets no auto-load.
 */
import {
	POSTBOX_ROW_HEIGHT,
	POSTBOX_SECTION_HEADER_HEIGHT,
	POSTBOX_VIRTUAL_THRESHOLD,
} from '~/utils/postboxDensity';
import { usePostboxSectionedVirtualList } from '~/composables/postbox/usePostboxVirtualList';
import { usePostboxListAutoLoad } from '~/composables/postbox/usePostboxListAutoLoad';
import { usePostboxListNow } from '~/composables/postbox/usePostboxListClock';

/** One section of the list. `label` is display text, already localized. */
export interface PostboxThreadListSection<Item> {
	key: string;
	label: string;
	icon: string;
	items: Item[];
	/**
	 * The header's count. Both sectioned views count UNREAD, never the total: a
	 * header that counted everything would read as a size, and the point of a
	 * split is to say what still needs the reader. Hidden at 0. `text` replaces
	 * the number when the count is not exact (a capped "99+").
	 */
	headerBadge?: { count: number; text?: string };
	/** More mail exists in THIS section (per-section paging). */
	canLoadMore?: boolean;
}

const props = defineProps<{
	sections: PostboxThreadListSection<T>[];
	collapsed: Record<string, boolean>;
	loading: boolean;
	/** The keyboard's reset key: a folder switch drops the focus. */
	folderRole: string;
	/** The DOM id the row's option element carries (aria-activedescendant). */
	rowDomId: (item: T) => string;
	/** Enter on a focused row. */
	onActivate: (item: T) => void;
	/** Extra classes for a row's `<li>` (the danger accent). */
	rowClass?: (item: T) => string | Record<string, boolean> | undefined;
	listLabel: string;
	emptyTitle: string;
	/** Section names are user text: render them as typed, not upper-cased. */
	verbatimLabels?: boolean;
	/** Whole-list paging: turns on auto-load and the fallback button. */
	hasMore?: boolean;
	/** Text of the fallback "load more" button (only used with `hasMore`). */
	loadMoreLabel?: string;
}>();

const emit = defineEmits<{
	(e: 'toggle', key: string): void;
	(e: 'load-more'): void;
}>();

defineSlots<{
	row(props: { item: T; focused: boolean }): unknown;
	'section-footer'?(props: { section: PostboxThreadListSection<T> }): unknown;
}>();

// One minute clock for every slotted row's timestamp (they inject it).
usePostboxListNow();

// Flatten the currently-visible rows (expanded sections only) into one list so
// arrow-key navigation flows across sections like the flat list does.
const visibleItems = computed(() =>
	props.sections.flatMap((s) => (props.collapsed[s.key] ? [] : s.items))
);
const { focusedIndex, activeId, onKeydown } = usePostboxListKeyboard<T>({
	items: visibleItems,
	resetKey: computed(() => props.folderRole),
	rowDomId: (item) => props.rowDomId(item),
	onActivate: (item) => props.onActivate(item),
});

function isFocused(item: T): boolean {
	return visibleItems.value[focusedIndex.value]?._id === item._id;
}

// --- Section-aware windowed rendering -----------------------------------------
// Rows are fixed-height per density and section headers are a known constant,
// so the window is pure arithmetic over the section row counts — no measuring.
// It is expressed as spacers around each section's mounted slice rather than
// one absolute translate, because the headers are `position: sticky` and
// sticky only works in normal flow.
const scrollEl = ref<HTMLElement | null>(null);
const { density } = usePostboxSettings();
const rowHeight = computed(() => POSTBOX_ROW_HEIGHT[density.value]);
const headerHeight = computed(() => POSTBOX_SECTION_HEADER_HEIGHT);
// A collapsed section contributes no rows and still costs its header — the
// same shape `visibleItems` flattens, so the two can't drift.
const sectionCounts = computed(() =>
	props.sections.map((s) => (props.collapsed[s.key] ? 0 : s.items.length))
);
const itemCount = computed(() => visibleItems.value.length);
const virtualize = computed(() => itemCount.value > POSTBOX_VIRTUAL_THRESHOLD);

const { windows, syncScroll, scrollToFlatIndex } = usePostboxSectionedVirtualList({
	scrollEl,
	sectionCounts,
	rowHeight,
	headerHeight,
	enabled: virtualize,
});

/** The rows of one section that are actually mounted, with their spacers. */
function sectionWindow(index: number) {
	return windows.value[index] ?? { startIndex: 0, endIndex: 0, padTop: 0, padBottom: 0 };
}

// j/k can land on a row outside the mounted window; shifting the scroll
// re-derives the window and mounts it, after which the keyboard composable's
// own scrollIntoView refines to "nearest".
watch(focusedIndex, (idx) => {
	if (idx < 0 || !virtualize.value) return;
	scrollToFlatIndex(idx);
});

// Grow the page before the seam shows, coalesced to one derivation per frame.
// Without `hasMore` this only syncs the window.
const { handleScroll } = usePostboxListAutoLoad({
	scrollEl,
	itemCount,
	hasMore: computed(() => props.hasMore === true),
	blocked: computed(() => props.loading),
	onScroll: () => syncScroll(),
	loadMore: () => emit('load-more'),
});
</script>

<template>
	<PostboxThreadListSkeleton v-if="loading && sections.length === 0" />
	<PostboxEmptyState
		v-else-if="sections.length === 0"
		icon="lucide:check-circle-2"
		:title="emptyTitle"
	/>
	<div v-else ref="scrollEl" class="h-full overflow-auto" @scroll="handleScroll()">
		<ul
			tabindex="0"
			role="listbox"
			:aria-label="listLabel"
			:aria-activedescendant="activeId"
			class="outline-none focus-visible:ring-1 focus-visible:ring-brand/40 focus-visible:ring-inset"
			@keydown="onKeydown"
		>
			<template v-for="(section, sectionIndex) in sections" :key="section.key">
				<!-- Collapsible section header. Pinned to the same constant the
				     sectioned window math charges per section, so the header can't
				     drift the rows below it either. -->
				<li class="sticky top-0 z-10 bg-bg-surface" :class="{ 'pbx-section-header': virtualize }">
					<button
						type="button"
						class="w-full flex items-center gap-2 px-4 py-2 text-xs font-semibold uppercase tracking-wider text-text-tertiary hover:bg-bg-elevated"
						:aria-expanded="!collapsed[section.key]"
						@click="emit('toggle', section.key)"
					>
						<Icon
							:name="collapsed[section.key] ? 'lucide:chevron-right' : 'lucide:chevron-down'"
							class="w-3.5 h-3.5 flex-shrink-0"
						/>
						<Icon :name="section.icon" class="w-3.5 h-3.5 flex-shrink-0" />
						<span
							class="flex-1 text-left"
							:class="{ 'normal-case tracking-normal': verbatimLabels }"
							>{{ section.label }}</span
						>
						<span
							v-if="section.headerBadge && section.headerBadge.count > 0"
							data-testid="section-unread"
							class="text-xs bg-brand text-text-inverse rounded-full px-1.5 min-w-[1.25rem] text-center font-normal"
							>{{ section.headerBadge.text ?? section.headerBadge.count }}</span
						>
					</button>
				</li>
				<template v-if="!collapsed[section.key]">
					<!-- Spacers stand in for the rows this section is not mounting, so
					     the scroll height stays honest and the sticky header above
					     stays in normal flow. -->
					<li
						v-if="sectionWindow(sectionIndex).padTop > 0"
						aria-hidden="true"
						:style="{ height: `${sectionWindow(sectionIndex).padTop}px` }"
					/>
					<!-- `pbx-virtual-row` pins the box to exactly the row height the
					     spacer math assumes (border-box, so the border-b hairline is
					     absorbed rather than added). Without it a natural-height row
					     drifts a little per row against padTop/padBottom, and the
					     section's painted rows stop lining up with its own spacers. -->
					<li
						v-for="item in section.items.slice(
							sectionWindow(sectionIndex).startIndex,
							sectionWindow(sectionIndex).endIndex
						)"
						:key="item._id"
						class="group relative border-b border-border-subtle"
						:class="[{ 'pbx-virtual-row': virtualize }, rowClass?.(item)]"
						style="
							content-visibility: auto;
							contain-intrinsic-size: auto var(--pbx-row-intrinsic, 76px);
						"
					>
						<slot name="row" :item="item" :focused="isFocused(item)" />
					</li>
					<li
						v-if="sectionWindow(sectionIndex).padBottom > 0"
						aria-hidden="true"
						:style="{ height: `${sectionWindow(sectionIndex).padBottom}px` }"
					/>
					<slot name="section-footer" :section="section" />
				</template>
			</template>
		</ul>
		<!-- Fallback trigger: the scroll auto-grows the page, but the button stays
		     so a user can still advance if the auto-load stalls. -->
		<div v-if="!loading && hasMore" class="p-3 text-center">
			<button type="button" class="text-sm text-brand hover:underline" @click="emit('load-more')">
				{{ loadMoreLabel }}
			</button>
		</div>
	</div>
</template>
