<script setup lang="ts">
/**
 * The Priority view's "Updates · no reply needed" group: mail
 * that needs nothing folds away. The first three rows
 * show, one line each; the rest fold into "9 more updates from GitHub,
 * Hetzner and 4 others", which opens them in place.
 */
import type { Id } from '@owlat/api/dataModel';
import type { PostboxThreadRowMessage } from './PostboxThreadRow.vue';
import { updatesFoldLine } from '~/utils/postboxPriorityGroups';

const SHOWN = 3;

const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	rows: PostboxThreadRowMessage[];
	scrollParent: HTMLElement | null;
	activeMessageId: string | null;
}>();

const emit = defineEmits<{ select: [messageId: string | null] }>();

const { t } = useI18n();
const isOpen = ref(false);
const shown = computed(() => (isOpen.value ? props.rows : props.rows.slice(0, SHOWN)));
const fold = computed(() => (isOpen.value ? null : updatesFoldLine(props.rows.slice(SHOWN))));
</script>

<template>
	<section
		v-if="rows.length > 0"
		id="postbox-updates"
		:aria-label="t('postbox.priority.updates.title')"
	>
		<h2
			class="flex items-baseline text-[11px] font-semibold uppercase tracking-wider text-text-tertiary"
		>
			{{ t('postbox.priority.updates.title') }}
			<span class="ml-auto tabular-nums">{{ rows.length }}</span>
		</h2>
		<div class="mt-2 rounded-lg border border-border-subtle bg-bg-surface overflow-hidden">
			<PostboxThreadList
				:mailbox-id="mailboxId"
				:messages="shown"
				:loading="false"
				folder-role="inbox"
				:scroll-parent="scrollParent"
				selectable
				:active-message-id="activeMessageId"
				@select="emit('select', $event)"
			/>
			<button
				v-if="fold"
				type="button"
				class="flex w-full items-baseline gap-2 border-t border-border-subtle px-4 py-2.5 text-left text-sm text-text-secondary hover:bg-(--surface-1-hover) focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-brand/40 outline-none"
				data-testid="priority-updates-fold"
				@click="isOpen = true"
			>
				<span class="flex-1 min-w-0 truncate">{{ t(fold.key, fold.params, fold.count) }}</span>
				<span class="flex-shrink-0 text-xs text-brand">{{
					t('postbox.priority.updates.show')
				}}</span>
			</button>
		</div>
	</section>
</template>
