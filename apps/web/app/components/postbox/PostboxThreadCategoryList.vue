<script setup lang="ts">
/**
 * Smart-inbox split view: threads grouped into People / Newsletters /
 * Notifications / Receipts / Everything else collapsible sections. An adapter
 * over PostboxSectionedThreadList (keyboard, windowing, sticky headers) that
 * renders the shared conversation row; each row carries a "Recategorize as…"
 * overflow action that writes a per-sender user override.
 */
import type { Id } from '@owlat/api/dataModel';
import { RECATEGORIZE_OPTIONS } from '~/composables/postbox/usePostboxThreadCategories';
import type { MailCategory } from '~/utils/mailCategory';
import type { PostboxConversationThread } from './PostboxConversationRow.vue';
import type { PostboxThreadListSection } from './PostboxSectionedThreadList.vue';

type CategoryThread = PostboxConversationThread & { category?: { label: string } };

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

function rowDomId(thread: CategoryThread) {
	return `postbox-cat-thread-${thread._id}`;
}

function openThread(thread: CategoryThread) {
	const to = threadTo(thread);
	if (to) void navigateTo(to);
}

// The header counts unread mail across the loaded conversations, the same
// meaning the split inbox uses (see PostboxThreadListSection.headerBadge).
const listSections = computed<PostboxThreadListSection<CategoryThread>[]>(() =>
	props.sections.map((section) => ({
		key: section.key,
		label: t(section.label),
		icon: section.icon,
		items: section.threads,
		headerBadge: {
			count: section.threads.reduce((sum, thread) => sum + thread.unreadCount, 0),
		},
	}))
);

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
	<PostboxSectionedThreadList
		:sections="listSections"
		:collapsed="collapsed"
		:loading="loading"
		:folder-role="folderRole"
		:row-dom-id="rowDomId"
		:on-activate="openThread"
		:list-label="t('components.postbox.postboxThreadCategoryList.listLabel')"
		:empty-title="t('components.postbox.postboxThreadCategoryList.allClear')"
		:has-more="hasMore === true"
		:load-more-label="t('components.postbox.postboxThreadCategoryList.loadMore')"
		@toggle="(key: string) => emit('toggle', key as MailCategory)"
		@load-more="emit('load-more')"
	>
		<template #row="{ item: thread, focused }">
			<PostboxConversationRow
				:thread="thread"
				:dom-id="rowDomId(thread)"
				:to="threadTo(thread)"
				:selected="focused"
				:active="!!activeMessageId && activeMessageId === thread.latestMessageId"
			/>
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
		</template>
	</PostboxSectionedThreadList>

	<UiModal
		:open="recategorizeTarget !== null"
		:title="t('components.postbox.postboxThreadCategoryList.recategorize')"
		size="sm"
		@update:open="
			(v: boolean) => {
				if (!v) recategorizeTarget = null;
			}
		"
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
