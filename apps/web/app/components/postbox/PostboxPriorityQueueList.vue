<script setup lang="ts">
/**
 * The Reply Queue's rows inside the Priority view's "Needs you" group (read on
 * arrival §3, plan §6): one line each, avatar and sender, what they want (the
 * brief's ask, else the AI's ask summary, else the subject) and one state.
 * Every row routes to the Answer queue, filtered to this mailbox: the queue
 * stays the doing surface.
 */
import {
	formatReplyQueueDueHint,
	replyQueueHeadline,
	type ReplyQueueItem,
} from '~/utils/postboxReplyQueue';
import { useLocalized } from '~/composables/useLocalized';

defineProps<{
	items: readonly ReplyQueueItem[];
	/** The Answer queue, filtered to this mailbox. */
	href: string;
}>();

const { t, locale } = useI18n();
// The queue helpers are pure: copy arrives as a key, message text as itself.
const text = useLocalized();

function who(item: ReplyQueueItem): string {
	return item.fromName?.trim() || item.fromAddress;
}

function state(item: ReplyQueueItem): { label: string; tone: 'brand' | 'warning' } {
	if (item.kind === 'followup')
		return { label: t('postbox.priority.state.waiting'), tone: 'warning' };
	const due = formatReplyQueueDueHint(item.dueHint, locale.value);
	return { label: due ? text(due) : t('postbox.priority.state.reply'), tone: 'brand' };
}

function hasDraft(item: ReplyQueueItem): boolean {
	return item.kind !== 'followup' && (item.hasDraftSlot === true || !!item.clarification?.draft);
}
</script>

<template>
	<ul class="divide-y divide-border-subtle" data-testid="priority-queue">
		<li v-for="item in items" :key="item.messageId">
			<NuxtLink
				:to="href"
				class="flex items-start sm:items-baseline gap-3 px-4 py-2.5 hover:bg-(--surface-1-hover) focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-brand/40 outline-none"
			>
				<UiAvatar
					:name="item.fromName"
					:email="item.fromAddress"
					deterministic-color
					size="sm"
					class="flex-shrink-0 self-center"
					aria-hidden="true"
				/>
				<span class="flex-1 min-w-0 flex gap-x-3 gap-y-0.5 max-sm:flex-col sm:items-baseline">
					<span
						class="flex items-baseline gap-2 truncate text-sm font-semibold text-text-primary sm:w-40 sm:flex-shrink-0"
					>
						<span class="truncate">{{ who(item) }}</span>
						<span
							class="ml-auto text-xs font-normal sm:hidden"
							:class="state(item).tone === 'warning' ? 'text-warning' : 'text-brand'"
							>{{ state(item).label }}</span
						>
					</span>
					<span
						class="min-w-0 flex-1 truncate text-sm text-text-secondary max-sm:whitespace-normal"
					>
						{{ text(replyQueueHeadline(item, locale)) }}
						<i v-if="hasDraft(item)" class="text-text-tertiary"
							>· {{ t('postbox.priority.draftReady') }}</i
						>
					</span>
					<span
						class="flex-shrink-0 text-xs max-sm:hidden"
						:class="state(item).tone === 'warning' ? 'text-warning' : 'text-brand'"
						>{{ state(item).label }}</span
					>
				</span>
			</NuxtLink>
		</li>
	</ul>
</template>
