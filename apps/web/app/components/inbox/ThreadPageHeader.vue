<script setup lang="ts">
import { formatRelativeTime } from '~/utils/formatters';
import {
	TEAM_THREAD_PRIORITY_CHIP_KEYS,
	type TeamThreadPriority,
} from '~/utils/teamThreadPriority';
import type { PresencePerson } from './InboxThreadPresence.vue';

/**
 * The Team Inbox thread page's header: the subject, once (the messages below
 * don't repeat it), the contact, message count, priority and snooze, and who
 * else is on the thread. The page's actions sit beside it, not in it.
 */
defineProps<{
	subject?: string;
	contact?: { email?: string } | null;
	messageCount?: number;
	priority: TeamThreadPriority;
	/** Set while the thread is snoozed. */
	snoozedUntil?: number | null;
	presencePeople: PresencePerson[];
}>();

const { t, locale } = useI18n();

// Times read relative ("2 hours ago"), with the exact moment in the reader's
// locale on hover — the same as everywhere else in the app.
function absoluteTime(timestamp: number): string {
	return new Date(timestamp).toLocaleString(locale.value, {
		dateStyle: 'medium',
		timeStyle: 'short',
	});
}
</script>

<template>
	<UiPageHeader class="min-w-0 flex-[1_1_24rem]">
		<!-- A subject can be one unbroken token (a URL, an order number). -->
		<template #title>
			<span class="break-words">{{ subject || t('dashboard.inbox.detail.noSubject') }}</span>
		</template>
		<template #meta>
			<p
				class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-tertiary"
				data-testid="thread-meta"
			>
				<span v-if="contact" class="text-text-secondary">{{ contact.email }}</span>
				<span v-if="contact" aria-hidden="true">·</span>
				<span>
					{{
						t(
							'dashboard.inbox.detail.messageCount',
							{ count: messageCount ?? 0 },
							messageCount ?? 0
						)
					}}
				</span>
				<template v-if="priority !== 'normal'">
					<span aria-hidden="true">·</span>
					<span
						class="inline-flex items-center gap-1"
						:class="priority === 'urgent' ? 'font-medium text-error' : ''"
						data-testid="thread-priority"
					>
						<Icon name="lucide:flag" class="w-3.5 h-3.5" aria-hidden="true" />
						{{ t(TEAM_THREAD_PRIORITY_CHIP_KEYS[priority]) }}
					</span>
				</template>
				<template v-if="snoozedUntil">
					<span aria-hidden="true">·</span>
					<span class="inline-flex items-center gap-1">
						<Icon name="lucide:alarm-clock" class="w-3.5 h-3.5" aria-hidden="true" />
						<time
							:datetime="new Date(snoozedUntil).toISOString()"
							:title="absoluteTime(snoozedUntil)"
						>
							{{
								t('dashboard.inbox.detail.snoozedUntil', {
									time: formatRelativeTime(snoozedUntil),
								})
							}}
						</time>
					</span>
				</template>
			</p>
			<!-- Who else is here — pulsing viewer ring + "is replying" banner -->
			<InboxThreadPresence :people="presencePeople" class="mt-3" />
		</template>
	</UiPageHeader>
</template>
