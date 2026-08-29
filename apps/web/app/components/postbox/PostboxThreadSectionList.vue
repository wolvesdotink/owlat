<script setup lang="ts">
/**
 * Split inbox (idea 24): the inbox rendered as ordered, collapsible SECTIONS
 * named by `pinToSection` filter rules, with per-section unread counts.
 *
 * Deliberately the same shape as PostboxThreadCategoryList — sticky collapsible
 * headers, one flattened keyboard order across the expanded sections, the
 * section-aware window — because the two are the same renderer over different
 * groupings. What differs is paging: each section carries its OWN "Load more",
 * because the server pages each section separately so a chatty section can never
 * starve a quiet one.
 */
import { POSTBOX_ROW_HEIGHT, POSTBOX_SECTION_HEADER_HEIGHT } from '~/utils/postboxDensity';
import { usePostboxSectionedVirtualList } from '~/composables/postbox/usePostboxVirtualList';
import type { PostboxInboxSection } from '~/composables/postbox/usePostboxThreadSections';

const props = defineProps<{
	sections: PostboxInboxSection[];
	collapsed: Record<string, boolean>;
	loading: boolean;
	folderRole: string;
	activeMessageId?: string | null;
}>();

const emit = defineEmits<{
	(e: 'load-more', key: string): void;
	(e: 'toggle', key: string): void;
}>();

const { t } = useI18n();

function messageTo(id: string) {
	return `/dashboard/postbox/${props.folderRole}/${id}`;
}

/** A section's visible name — the remainder has no name of its own. */
function sectionLabel(section: PostboxInboxSection): string {
	return section.name ?? t('components.postbox.postboxThreadSectionList.everythingElse');
}

// Flatten the currently-visible rows (expanded sections only) so arrow-key
// navigation flows across sections exactly like the flat list.
const visibleMessages = computed(() =>
	props.sections.flatMap((s) => (props.collapsed[s.key] ? [] : s.messages))
);
const { focusedIndex, activeId, onKeydown } = usePostboxListKeyboard({
	items: visibleMessages,
	resetKey: computed(() => props.folderRole),
	rowDomId: (msg) => `postbox-sec-msg-${msg._id}`,
	onActivate: (msg) => void navigateTo(messageTo(msg._id)),
});

// Section-aware windowed rendering. Rows are fixed-height per density and the
// header is a known constant, so the window is pure arithmetic — expressed as
// spacers around each section's mounted slice because the headers are sticky and
// sticky only works in normal flow.
const VIRTUAL_THRESHOLD = 100;
const scrollEl = ref<HTMLElement | null>(null);
const { density } = usePostboxSettings();
const rowHeight = computed(() => POSTBOX_ROW_HEIGHT[density.value]);
const headerHeight = computed(() => POSTBOX_SECTION_HEADER_HEIGHT);
const sectionCounts = computed(() =>
	props.sections.map((s) => (props.collapsed[s.key] ? 0 : s.messages.length))
);
const itemCount = computed(() => visibleMessages.value.length);
const virtualize = computed(() => itemCount.value > VIRTUAL_THRESHOLD);

const { windows, syncScroll, scrollToFlatIndex } = usePostboxSectionedVirtualList({
	scrollEl,
	sectionCounts,
	rowHeight,
	headerHeight,
	enabled: virtualize,
});

function sectionWindow(index: number) {
	return windows.value[index] ?? { startIndex: 0, endIndex: 0, padTop: 0, padBottom: 0 };
}

// j/k can land on a row outside the mounted window; shifting the scroll
// re-derives the window and mounts it.
watch(focusedIndex, (idx) => {
	if (idx < 0 || !virtualize.value) return;
	scrollToFlatIndex(idx);
});

// No auto-load here, and that is the point: "load more" belongs to ONE section,
// so a scroll near the bottom of the viewport cannot say which section the
// reader meant. Each section asks for its own next page explicitly.
</script>

<template>
	<PostboxThreadListSkeleton v-if="loading && sections.length === 0" />
	<PostboxEmptyState
		v-else-if="sections.length === 0"
		icon="lucide:check-circle-2"
		:title="t('components.postbox.postboxThreadSectionList.allClear')"
	/>
	<div v-else ref="scrollEl" class="h-full overflow-auto" @scroll="syncScroll()">
		<ul
			tabindex="0"
			role="listbox"
			:aria-label="t('components.postbox.postboxThreadSectionList.listLabel')"
			:aria-activedescendant="activeId"
			class="outline-none focus-visible:ring-1 focus-visible:ring-brand/40 focus-visible:ring-inset"
			@keydown="onKeydown"
		>
			<template v-for="(section, sectionIndex) in sections" :key="section.key">
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
						<Icon
							:name="section.name ? 'lucide:pin' : 'lucide:inbox'"
							class="w-3.5 h-3.5 flex-shrink-0"
						/>
						<span class="flex-1 text-left normal-case tracking-normal">{{
							sectionLabel(section)
						}}</span>
						<!-- The count is UNREAD, not total: a section header that counted
						     everything would read as a size, and the whole point of the
						     split is to say what still needs the reader. -->
						<span
							v-if="section.unreadCount > 0"
							class="text-xs bg-brand text-text-inverse rounded-full px-1.5 min-w-[1.25rem] text-center font-normal"
							>{{
								section.isUnreadCapped
									? t('components.postbox.postboxThreadSectionList.unreadCapped', {
											count: section.unreadCount,
										})
									: section.unreadCount
							}}</span
						>
					</button>
				</li>
				<template v-if="!collapsed[section.key]">
					<li
						v-if="sectionWindow(sectionIndex).padTop > 0"
						aria-hidden="true"
						:style="{ height: `${sectionWindow(sectionIndex).padTop}px` }"
					/>
					<li
						v-for="msg in section.messages.slice(
							sectionWindow(sectionIndex).startIndex,
							sectionWindow(sectionIndex).endIndex
						)"
						:key="msg._id"
						class="group relative border-b border-border-subtle"
						:class="{ 'pbx-virtual-row': virtualize }"
						style="
							content-visibility: auto;
							contain-intrinsic-size: auto var(--pbx-row-intrinsic, 76px);
						"
					>
						<NuxtLink
							:id="`postbox-sec-msg-${msg._id}`"
							role="option"
							:aria-selected="visibleMessages[focusedIndex]?._id === msg._id"
							:to="messageTo(msg._id)"
							class="pbx-row-link block px-4 py-3 hover:bg-bg-elevated"
							:class="{ 'bg-bg-elevated': activeMessageId === msg._id }"
						>
							<div class="flex items-baseline justify-between gap-3">
								<span
									class="truncate text-sm"
									:class="msg.flagSeen ? 'text-text-secondary' : 'font-semibold text-text-primary'"
								>
									{{ msg.fromName || msg.fromAddress }}
								</span>
								<span class="text-xs text-text-tertiary flex-shrink-0">
									{{ formatThreadTimestamp(msg.receivedAt) }}
								</span>
							</div>
							<div class="flex items-center gap-1.5 mt-0.5">
								<Icon v-if="msg.flagFlagged" name="lucide:star" class="w-3.5 h-3.5 text-warning" />
								<Icon
									v-if="msg.hasAttachments"
									name="lucide:paperclip"
									class="w-3.5 h-3.5 text-text-tertiary"
								/>
								<p
									class="truncate text-sm flex-1"
									:class="msg.flagSeen ? 'text-text-secondary' : 'font-medium text-text-primary'"
								>
									{{ msg.subject || t('components.postbox.postboxThreadSectionList.noSubject') }}
								</p>
							</div>
							<p class="pbx-row-snippet text-xs text-text-tertiary truncate mt-0.5">
								{{ msg.snippet }}
							</p>
						</NuxtLink>
					</li>
					<li
						v-if="sectionWindow(sectionIndex).padBottom > 0"
						aria-hidden="true"
						:style="{ height: `${sectionWindow(sectionIndex).padBottom}px` }"
					/>
					<!-- Per-section paging: this button grows THIS section only. -->
					<li v-if="section.canLoadMore" class="px-4 py-2">
						<button
							type="button"
							class="text-sm text-brand hover:underline"
							@click="emit('load-more', section.key)"
						>
							{{
								t('components.postbox.postboxThreadSectionList.loadMoreIn', {
									section: sectionLabel(section),
								})
							}}
						</button>
					</li>
				</template>
			</template>
		</ul>
	</div>
</template>
