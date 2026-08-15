<script setup lang="ts">
/**
 * Smart-inbox split view: threads grouped into People / Newsletters /
 * Notifications / Receipts / Everything else collapsible sections with counts.
 * Reuses the conversation-view row markup and keyboard triage; each row carries
 * a "Recategorize as…" overflow action that writes a per-sender user override.
 */
import type { Id } from '@owlat/api/dataModel';
import {
	RECATEGORIZE_OPTIONS,
	type MailCategory,
} from '~/composables/postbox/usePostboxThreadCategories';

type CategoryThread = {
	_id: string;
	latestMessageId?: string;
	latestFromAddress: string;
	latestSubject: string;
	latestSnippet: string;
	lastMessageAt: number;
	messageCount: number;
	unreadCount: number;
	hasFlagged: boolean;
	hasAttachments: boolean;
	category?: { label: string };
};

const props = defineProps<{
	sections: Array<{ key: MailCategory; label: string; icon: string; threads: CategoryThread[] }>;
	collapsed: Record<string, boolean>;
	loading: boolean;
	folderRole: string;
	activeMessageId?: string | null;
	hasMore?: boolean;
}>();

const emit = defineEmits<{
	(e: 'load-more'): void;
	(e: 'toggle', key: MailCategory): void;
	(e: 'recategorize', threadId: Id<'mailThreads'>, label: MailCategory): void;
}>();

const { t } = useI18n();

function threadTo(thread: { latestMessageId?: string }) {
	return thread.latestMessageId
		? `/dashboard/postbox/${props.folderRole}/${thread.latestMessageId}`
		: '';
}

// Flatten the currently-visible rows (expanded sections only) into one list so
// arrow-key navigation flows across sections like the flat list does.
const visibleThreads = computed(() =>
	props.sections.flatMap((s) => (props.collapsed[s.key] ? [] : s.threads))
);
const visibleRef = computed(() => visibleThreads.value);
const { focusedIndex, activeId, onKeydown } = usePostboxListKeyboard({
	items: visibleRef,
	resetKey: computed(() => props.folderRole),
	rowDomId: (thread) => `postbox-cat-thread-${thread._id}`,
	onActivate: (thread) => {
		const to = threadTo(thread);
		if (to) void navigateTo(to);
	},
});

// "Recategorize as…" picker — driven per row.
const recategorizeTarget = ref<string | null>(null);
function pickCategory(label: MailCategory) {
	if (recategorizeTarget.value) {
		emit('recategorize', recategorizeTarget.value as Id<'mailThreads'>, label);
	}
	recategorizeTarget.value = null;
}
</script>

<template>
	<PostboxThreadListSkeleton v-if="loading && sections.length === 0" />
	<PostboxEmptyState
		v-else-if="sections.length === 0"
		icon="lucide:check-circle-2"
		:title="t('components.postbox.postboxThreadCategoryList.allClear')"
	/>
	<div v-else>
		<ul
			tabindex="0"
			role="listbox"
			:aria-label="t('components.postbox.postboxThreadCategoryList.listLabel')"
			:aria-activedescendant="activeId"
			class="outline-none focus-visible:ring-1 focus-visible:ring-brand/40 focus-visible:ring-inset"
			@keydown="onKeydown"
		>
			<template v-for="section in sections" :key="section.key">
				<!-- Collapsible section header with a count. -->
				<li class="sticky top-0 z-10 bg-bg-surface">
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
						<span class="flex-1 text-left">{{ t(section.label) }}</span>
						<span class="text-text-tertiary font-normal">{{ section.threads.length }}</span>
					</button>
				</li>
				<template v-if="!collapsed[section.key]">
					<li
						v-for="thread in section.threads"
						:key="thread._id"
						class="group relative border-b border-border-subtle"
						style="content-visibility: auto; contain-intrinsic-size: auto var(--pbx-row-intrinsic, 76px)"
					>
						<NuxtLink
							:id="`postbox-cat-thread-${thread._id}`"
							role="option"
							:aria-selected="visibleThreads[focusedIndex]?._id === thread._id"
							:to="threadTo(thread)"
							class="pbx-row-link block px-4 py-3 hover:bg-bg-elevated"
							:class="{ 'bg-bg-elevated': activeMessageId && activeMessageId === thread.latestMessageId }"
						>
							<div class="flex items-baseline justify-between gap-3">
								<span
									class="truncate text-sm"
									:class="thread.unreadCount > 0 ? 'font-semibold text-text-primary' : 'text-text-secondary'"
								>
									{{ thread.latestFromAddress }}
									<span v-if="thread.messageCount > 1" class="text-text-tertiary font-normal"
										>({{ thread.messageCount }})</span
									>
								</span>
								<span class="text-xs text-text-tertiary flex-shrink-0">
									{{ formatThreadTimestamp(thread.lastMessageAt) }}
								</span>
							</div>
							<div class="flex items-center gap-1.5 mt-0.5">
								<Icon v-if="thread.hasFlagged" name="lucide:star" class="w-3.5 h-3.5 text-warning" />
								<Icon
									v-if="thread.hasAttachments"
									name="lucide:paperclip"
									class="w-3.5 h-3.5 text-text-tertiary"
								/>
								<p
									class="truncate text-sm flex-1"
									:class="thread.unreadCount > 0 ? 'font-medium text-text-primary' : 'text-text-secondary'"
								>
									{{
									thread.latestSubject ||
									t('components.postbox.postboxThreadCategoryList.noSubject')
								}}
								</p>
								<span
									v-if="thread.unreadCount > 0"
									class="text-xs bg-brand text-text-inverse rounded-full px-1.5 min-w-[1.25rem] text-center"
								>{{ thread.unreadCount }}</span>
							</div>
							<p class="pbx-row-snippet text-xs text-text-tertiary truncate mt-0.5">{{ thread.latestSnippet }}</p>
						</NuxtLink>
						<!-- Overflow: recategorize this sender's mail. -->
						<button
							type="button"
							class="absolute top-2 right-2 opacity-0 group-hover:opacity-100 focus:opacity-100 p-1 rounded bg-bg-surface/80 text-text-tertiary hover:text-text-primary"
							:title="t('components.postbox.postboxThreadCategoryList.recategorize')"
							:aria-label="t('components.postbox.postboxThreadCategoryList.recategorize')"
							@click.prevent.stop="recategorizeTarget = thread._id"
						>
							<Icon name="lucide:tag" class="w-3.5 h-3.5" />
						</button>
					</li>
				</template>
			</template>
		</ul>
		<div v-if="!loading && hasMore" class="p-3 text-center">
			<button type="button" class="text-sm text-brand hover:underline" @click="emit('load-more')">
				{{ t('components.postbox.postboxThreadCategoryList.loadMore') }}
			</button>
		</div>
	</div>

	<UiModal
		:open="recategorizeTarget !== null"
		:title="t('components.postbox.postboxThreadCategoryList.recategorize')"
		size="sm"
		@update:open="(v: boolean) => { if (!v) recategorizeTarget = null; }"
	>
		<ul class="space-y-1">
			<li v-for="option in RECATEGORIZE_OPTIONS" :key="option.key">
				<button
					type="button"
					class="w-full flex items-center gap-2 px-3 py-2 rounded hover:bg-bg-surface text-left text-sm"
					@click="pickCategory(option.key)"
				>
					{{ t(option.label) }}
				</button>
			</li>
		</ul>
		<p class="mt-3 text-xs text-text-tertiary">
			{{ t('components.postbox.postboxThreadCategoryList.recategorizeHint') }}
		</p>
	</UiModal>
</template>
