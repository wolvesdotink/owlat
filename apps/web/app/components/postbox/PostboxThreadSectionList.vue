<script setup lang="ts">
/**
 * Split inbox (idea 24): the inbox rendered as ordered, collapsible SECTIONS
 * named by `pinToSection` filter rules, with per-section unread counts.
 *
 * An adapter over PostboxSectionedThreadList, the same shell the categories
 * view uses: the two are the same renderer over different groupings. What
 * differs is paging: each section carries its OWN "Load more", because the
 * server pages each section separately so a chatty section can never starve a
 * quiet one. So there is no scroll auto-load here: a scroll near the bottom of
 * the viewport cannot say which section the reader meant.
 */
import type { PostboxInboxSection } from '~/composables/postbox/usePostboxThreadSections';
import type { PostboxThreadRowMessage } from './PostboxThreadRow.vue';
import type { PostboxThreadListSection } from './PostboxSectionedThreadList.vue';
import { senderRowMarkerOf } from '~/utils/senderAuth';

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

// The sender-trust marker gate, resolved once for the list (not per row).
const { isEnabled } = useFeatureFlag();
const trustMarkers = computed(() => isEnabled('senderAuthBadges'));

function messageTo(id: string) {
	return `/dashboard/postbox/${props.folderRole}/${id}`;
}

function rowDomId(msg: PostboxThreadRowMessage) {
	return `postbox-sec-msg-${msg._id}`;
}

function rowClass(msg: PostboxThreadRowMessage) {
	return { 'pbx-row-danger': senderRowMarkerOf(msg, trustMarkers.value) !== null };
}

// The header badge is the server's unread count, a floor when capped ("99+").
const listSections = computed<PostboxThreadListSection<PostboxThreadRowMessage>[]>(() =>
	props.sections.map((section) => ({
		key: section.key,
		// The remainder has no name of its own.
		label: section.name ?? t('components.postbox.postboxThreadSectionList.everythingElse'),
		icon: section.name ? 'lucide:pin' : 'lucide:inbox',
		items: section.messages,
		headerBadge: {
			count: section.unreadCount,
			text: section.isUnreadCapped
				? t('components.postbox.postboxThreadSectionList.unreadCapped', {
						count: section.unreadCount,
					})
				: undefined,
		},
		canLoadMore: section.canLoadMore,
	}))
);
</script>

<template>
	<PostboxSectionedThreadList
		:sections="listSections"
		:collapsed="collapsed"
		:loading="loading"
		:folder-role="folderRole"
		:row-dom-id="rowDomId"
		:on-activate="(msg: PostboxThreadRowMessage) => void navigateTo(messageTo(msg._id))"
		:row-class="rowClass"
		:list-label="t('components.postbox.postboxThreadSectionList.listLabel')"
		:empty-title="t('components.postbox.postboxThreadSectionList.allClear')"
		verbatim-labels
		@toggle="(key: string) => emit('toggle', key)"
	>
		<template #row="{ item: msg, focused }">
			<NuxtLink
				:id="rowDomId(msg)"
				role="option"
				:aria-selected="focused"
				:to="messageTo(msg._id)"
				class="pbx-row-link block px-4 py-3 hover:bg-bg-elevated"
				:class="{ 'bg-bg-elevated': activeMessageId === msg._id }"
			>
				<PostboxThreadRowBody :msg="msg" :trust-markers="trustMarkers" />
			</NuxtLink>
		</template>
		<!-- Per-section paging: this button grows THIS section only. -->
		<template #section-footer="{ section }">
			<li v-if="section.canLoadMore" class="px-4 py-2">
				<button
					type="button"
					class="text-sm text-brand hover:underline"
					@click="emit('load-more', section.key)"
				>
					{{
						t('components.postbox.postboxThreadSectionList.loadMoreIn', {
							section: section.label,
						})
					}}
				</button>
			</li>
		</template>
	</PostboxSectionedThreadList>
</template>
