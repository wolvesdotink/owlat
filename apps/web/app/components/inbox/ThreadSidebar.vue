<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import { formatRelativeTime } from '~/utils/formatters';
import type { ThreadAutoCloseFact } from '~/utils/inboxAutoClose';

/**
 * The Team Inbox thread page's side column: the brief from elsewhere, the
 * contact, the facts about the thread, and its SMS / WhatsApp timeline. Every
 * fact here READS; the header is where each of them is changed.
 */
defineProps<{
	threadId: Id<'conversationThreads'>;
	contact: {
		_id: string;
		email?: string;
		firstName?: string;
		lastName?: string;
	} | null;
	messageCount?: number;
	assignedTo?: string | null;
	assignedMemberName: string | null;
	lastMessageAt?: number;
	autoCloseFact: ThreadAutoCloseFact | null;
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
	<div class="space-y-6">
		<BriefElsewhere :thread-ref="{ kind: 'team', id: threadId }" class="card" />
		<!-- Contact Card -->
		<div v-if="contact" class="card">
			<h2 class="text-lg font-medium text-text-primary mb-4">
				{{ t('dashboard.inbox.detail.contact') }}
			</h2>
			<div class="space-y-3">
				<div class="flex items-center gap-3">
					<UiIconBox icon="lucide:user" size="sm" variant="surface" rounded="full" />
					<div>
						<p class="text-text-primary text-sm font-medium">
							{{
								contact.firstName || contact.lastName
									? `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim()
									: contact.email
							}}
						</p>
						<p class="text-xs text-text-tertiary">{{ contact.email }}</p>
					</div>
				</div>
				<NuxtLink
					:to="`/dashboard/audience/contacts/${contact._id}`"
					class="text-sm text-brand hover:underline"
				>
					{{ t('dashboard.inbox.detail.viewContactProfile') }}
				</NuxtLink>
			</div>
		</div>

		<!-- Thread Details. Status is changed in the header (its one
		     control) and not repeated here. -->
		<div class="card">
			<h2 class="text-lg font-medium text-text-primary mb-4">
				{{ t('dashboard.inbox.detail.details') }}
			</h2>
			<div class="space-y-3">
				<div>
					<p class="text-xs text-text-tertiary">{{ t('dashboard.inbox.detail.messages') }}</p>
					<p class="text-text-primary">{{ messageCount ?? 0 }}</p>
				</div>
				<!-- Assignment READS here and is CHANGED in the header (and on row
				     hover in the list). A second assign popover here would render
				     the same verb twice on one screen; the details card is a list
				     of facts about the thread, and this is one of them. -->
				<div>
					<p class="text-xs text-text-tertiary mb-1">
						{{ t('dashboard.inbox.detail.assignedTo') }}
					</p>
					<div class="flex items-center gap-2 text-sm text-text-primary">
						<UiAvatar
							v-if="assignedTo"
							:name="assignedMemberName ?? undefined"
							deterministic-color
							size="sm"
						/>
						<Icon v-else name="lucide:user-round" class="w-4 h-4 text-text-tertiary" />
						<span class="truncate">
							{{ assignedMemberName ?? t('dashboard.inbox.detail.unassigned') }}
						</span>
					</div>
				</div>
				<div v-if="lastMessageAt">
					<p class="text-xs text-text-tertiary">
						{{ t('dashboard.inbox.detail.lastMessage') }}
					</p>
					<time
						class="text-text-primary text-sm"
						:datetime="new Date(lastMessageAt).toISOString()"
						:title="absoluteTime(lastMessageAt)"
					>
						{{ formatRelativeTime(lastMessageAt) }}
					</time>
				</div>
				<!-- Auto-close READS here and is switched in the header's ⋯ menu. -->
				<div v-if="autoCloseFact" data-testid="thread-auto-close-fact">
					<p class="text-xs text-text-tertiary">
						{{ t('dashboard.inbox.detail.autoClose.label') }}
					</p>
					<p v-if="'dueAt' in autoCloseFact" class="text-sm text-text-primary">
						<time
							:datetime="new Date(autoCloseFact.dueAt).toISOString()"
							:title="absoluteTime(autoCloseFact.dueAt)"
						>
							{{ t(autoCloseFact.key, { time: formatRelativeTime(autoCloseFact.dueAt) }) }}
						</time>
					</p>
					<p v-else-if="'days' in autoCloseFact" class="text-sm text-text-primary">
						{{ t(autoCloseFact.key, { days: autoCloseFact.days }, autoCloseFact.days) }}
					</p>
					<p v-else class="text-sm text-text-primary">{{ t(autoCloseFact.key) }}</p>
				</div>
			</div>
		</div>

		<!-- SMS / WhatsApp on this thread, answerable here; nothing for email-only threads. -->
		<InboxThreadChannelTimeline :thread-id="threadId" />
	</div>
</template>
