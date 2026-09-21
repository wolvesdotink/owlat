<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

/**
 * The thread header: subject, message count, the follow-up chip, the team badge,
 * the label chips — and ONE ⋯ menu.
 *
 * Four separate toggle chips used to sit between the subject and the first word
 * of the message (alerting-on-reply, muted, back-from-snooze, mark-read). They
 * are conversation STATE, not daily verbs, so they moved into the menu as
 * checkable items: the check IS the state, and clicking it is still the way back
 * out. Nothing was dropped — mark-read still appears only under the `manual`
 * mark-read policy, and back-from-snooze is still the one-shot recognition cue
 * (informational, cleared by the reader on open).
 *
 * The follow-up chip stays visible: it carries a date and real actions rather
 * than a binary state.
 */
const props = defineProps<{
	subject?: string;
	messageCount: number;
	messageId: Id<'mailMessages'>;
	thread?: {
		_id: string;
		followUp?: { messageId: string; remindAt: number; dueAt?: number; waitingOn?: string };
		/** Muted conversation (mail/mute.ts) — new mail skips the inbox. */
		mutedAt?: number;
		/**
		 * Armed with "notify me when they reply" (mail/threadAlerts.ts) — a new
		 * message here toasts through quiet hours and the people-only scope.
		 */
		notifyOnReplyAt?: number;
		/** Just came back from snooze (mail/snooze.ts sweep); cleared on open. */
		snoozeReturnedAt?: number;
	} | null;
	latestOutboundId?: string;
	labelIds: string[];
	labels: Map<string, { _id: string; name: string; color?: string }>;
	/** Offer the explicit mark-read affordance (markReadPolicy 'manual', unread thread). */
	showMarkRead?: boolean;
	/** True while the mark-read mutation is in flight. */
	markingRead?: boolean;
}>();

const emit = defineEmits<{
	(e: 'toggle-mute'): void;
	(e: 'mark-read'): void;
	(e: 'toggle-alert'): void;
}>();

const { t } = useI18n();

const isMuted = computed(() => props.thread?.mutedAt != null);
const isAlerted = computed(() => props.thread?.notifyOnReplyAt != null);
const cameBackFromSnooze = computed(() => props.thread?.snoozeReturnedAt != null);

/** Shared item shape — one string rather than four copies drifting apart. */
const ITEM_CLASS =
	'w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left whitespace-nowrap text-text-primary hover:bg-bg-surface disabled:opacity-60';
</script>

<template>
	<header class="pbx-reader-header mb-4">
		<div class="flex items-start gap-2">
			<h1 class="flex-1 min-w-0 text-2xl font-medium tracking-[-0.02em] text-text-primary">
				{{ subject || t('components.postbox.postboxThreadHeader.noSubject') }}
				<span
					v-if="messageCount > 1"
					class="ml-1 text-base font-normal text-text-tertiary align-middle"
				>
					({{ messageCount }})
				</span>
			</h1>
			<!-- The conversation's state, made checkable. -->
			<PostboxOverflowMenu
				class="flex-shrink-0"
				:label="t('components.postbox.postboxThreadHeader.menuLabel')"
			>
				<template #default="{ close }">
					<button
						type="button"
						role="menuitemcheckbox"
						:aria-checked="isAlerted"
						:class="ITEM_CLASS"
						:title="t('components.postbox.postboxThreadHeader.alertedHint')"
						data-testid="thread-menu-alert"
						@click="
							emit('toggle-alert');
							close();
						"
					>
						<Icon
							name="lucide:check"
							class="w-3.5 h-3.5 flex-shrink-0 text-brand"
							:class="{ invisible: !isAlerted }"
							aria-hidden="true"
						/>
						{{ t('components.postbox.postboxThreadHeader.alertOnReply') }}
					</button>
					<button
						type="button"
						role="menuitemcheckbox"
						:aria-checked="isMuted"
						:class="ITEM_CLASS"
						:title="t('components.postbox.postboxThreadHeader.unmuteHint')"
						data-testid="thread-menu-mute"
						@click="
							emit('toggle-mute');
							close();
						"
					>
						<Icon
							name="lucide:check"
							class="w-3.5 h-3.5 flex-shrink-0 text-brand"
							:class="{ invisible: !isMuted }"
							aria-hidden="true"
						/>
						{{ t('components.postbox.postboxThreadHeader.muteConversation') }}
					</button>
					<!-- Mark-read is an ACTION, not a state, and only exists under the
					     manual mark-read policy while the thread still has unread mail. -->
					<button
						v-if="showMarkRead"
						type="button"
						role="menuitem"
						:class="ITEM_CLASS"
						:disabled="markingRead"
						data-testid="thread-menu-mark-read"
						@click="
							emit('mark-read');
							close();
						"
					>
						<Icon
							name="lucide:mail-open"
							class="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary"
							aria-hidden="true"
						/>
						{{ t('components.postbox.postboxThreadHeader.markRead') }}
					</button>
					<!-- The one-shot "you asked for this back" cue: a state with no verb,
					     so it reads as a checked, non-actionable row. -->
					<p
						v-if="cameBackFromSnooze"
						role="menuitem"
						aria-disabled="true"
						:class="ITEM_CLASS"
						data-testid="thread-menu-back-from-snooze"
					>
						<Icon
							name="lucide:undo-2"
							class="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary"
							aria-hidden="true"
						/>
						{{ t('components.postbox.postboxThreadHeader.backFromSnooze') }}
					</p>
				</template>
			</PostboxOverflowMenu>
		</div>
		<PostboxFollowUpChip
			v-if="thread"
			:thread="thread"
			:latest-outbound-id="latestOutboundId"
			class="mt-2"
		/>
		<PostboxTeamReplyBadge :message-id="messageId" class="mt-2" />
		<div v-if="labelIds.length > 0" class="mt-2 flex flex-wrap items-center gap-1.5">
			<span
				v-for="labelId in labelIds"
				:key="labelId"
				class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs"
				:style="{
					backgroundColor: (labels.get(labelId)?.color || '#6b7280') + '20',
					color: labels.get(labelId)?.color || '#6b7280',
				}"
			>
				<span
					class="w-1.5 h-1.5 rounded-full"
					:style="{ backgroundColor: labels.get(labelId)?.color || '#6b7280' }"
				/>
				{{ labels.get(labelId)?.name }}
			</span>
		</div>
	</header>
</template>
