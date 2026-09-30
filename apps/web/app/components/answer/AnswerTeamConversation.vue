<script setup lang="ts">
import type { api } from '@owlat/api';
import type { FunctionReturnType } from 'convex/server';
import type { AnswerConversationView } from '~/components/answer/AnswerConversation.vue';
import { formatCompactRelativeTime } from '~/utils/formatters';
import { teamConversationEntries, teamConversationOpenIds } from '~/utils/answerTeamConversation';

type ThreadData = NonNullable<FunctionReturnType<typeof api.inbox.queries.getThread>>;
type ThreadMessage = ThreadData['messages'][number];
type ThreadContact = ThreadData['contact'];
type FollowUp = FunctionReturnType<typeof api.inbox.followUps.listForThread>[number];

/**
 * Answer mode's left column for a Team inbox thread (plan §07): the customer's
 * messages with their HTML bodies, rendered by the Postbox's sandboxed body
 * component (quotes folded, remote images behind "Show images"), each followed
 * by what the team sent back (a body too large for its row shows as on the
 * thread page: its excerpt, then the full text). The newest message, and the one the reply
 * answers, open in full; older ones are one-line rows. "Full conversation"
 * (`t` on the page) opens them all.
 *
 * The agent's working, the retry of a failed message and assignment stay on
 * the thread page; this column is only what is being answered.
 */
const props = defineProps<{
	messages: readonly ThreadMessage[];
	followUps: readonly FollowUp[];
	contact: ThreadContact;
	/** The message the reply answers. */
	answeringId: string | null;
	/** A follow-up author's display name. */
	memberName: (userId: string) => string;
	undoingFollowUpId?: string | null;
}>();

const view = defineModel<AnswerConversationView>('view', { default: 'summary' });
const emit = defineEmits<{ (e: 'undo-follow-up', followUpId: FollowUp['_id']): void }>();

const { t } = useI18n();

const entries = computed(() => teamConversationEntries(props.messages, props.followUps));
const defaultOpen = computed(() => teamConversationOpenIds(props.messages, props.answeringId));
// Rows a person opened or closed by hand, over the default.
const toggled = ref(new Set<string>());
function isOpen(id: string): boolean {
	if (view.value === 'full') return true;
	return defaultOpen.value.has(id) !== toggled.value.has(id);
}
// A catch-up marker: open the message, bring it into view, and ring it briefly.
const flashed = ref<string | null>(null);
function reveal(id: string) {
	if (!isOpen(id)) toggle(id);
	void nextTick(() => {
		const el = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
		const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
		el?.scrollIntoView?.({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
		flashed.value = id;
		setTimeout(() => {
			if (flashed.value === id) flashed.value = null;
		}, 1600);
	});
}
function toggle(id: string) {
	const next = new Set(toggled.value);
	if (next.has(id)) next.delete(id);
	else next.add(id);
	toggled.value = next;
}

// A message header names its sender when that sender is the thread's contact;
// the address stays beside it, muted. Anyone else keeps the bare address.
function senderName(message: ThreadMessage): string | null {
	const c = props.contact;
	if (!c) return null;
	const isContact =
		message.contactId === c._id || message.from.toLowerCase() === (c.email ?? '').toLowerCase();
	if (!isContact) return null;
	return `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || null;
}

function bodyOf(message: ThreadMessage) {
	return {
		_id: message._id,
		htmlBodyInline: message.htmlBody || undefined,
		textBodyInline: message.htmlBody ? undefined : message.textBody || undefined,
		fromAddress: message.from,
	};
}

function preview(message: ThreadMessage): string {
	return (message.textBody || message.bodyExcerpt || '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

// A body too large for its row is in storage and the query only has its
// excerpt; the thread page's body component shows that, marked as the start of
// the message, until the full text arrives.
function hasInlineBody(message: ThreadMessage): boolean {
	return Boolean(message.htmlBody || message.textBody?.trim());
}
function hasStoredBody(message: ThreadMessage): boolean {
	return message.textBodyStorageId !== undefined || message.htmlBodyStorageId !== undefined;
}

function sentReplyAuthor(message: ThreadMessage): string {
	return message.approvalSource === 'auto'
		? t('dashboard.inbox.detail.outbound.agent')
		: t('dashboard.inbox.detail.outbound.yourTeam');
}

const showViewToggle = computed(() => props.messages.length > 1);
</script>

<template>
	<div
		class="mx-auto flex max-w-3xl flex-col gap-2 p-4 md:p-6"
		data-testid="answer-team-conversation"
	>
		<div v-if="showViewToggle" class="flex justify-end">
			<div
				role="group"
				:aria-label="t('components.answer.mode.viewLabel')"
				class="inline-flex rounded-md border border-border-subtle bg-bg-elevated p-0.5 text-xs"
			>
				<button
					v-for="option in ['summary', 'full'] as const"
					:key="option"
					type="button"
					class="rounded px-2.5 py-1"
					:class="
						view === option
							? 'bg-(--surface-2-selected) text-text-primary'
							: 'text-text-tertiary hover:text-text-primary'
					"
					:aria-pressed="view === option"
					:title="t('components.answer.mode.viewShortcut')"
					:data-testid="`answer-view-${option}`"
					@click="view = option"
				>
					{{ t(`components.answer.mode.view.${option}`) }}
				</button>
			</div>
		</div>

		<!-- The catch-up card (summary, asks) of a thread worth summarising. -->
		<slot name="catch-up" :view="view" :reveal="reveal" />

		<template v-for="entry in entries" :key="entry.key">
			<article
				v-if="entry.kind === 'inbound'"
				class="rounded-(--radius-card) border border-border-subtle bg-bg-elevated transition-shadow"
				:class="{ 'ring-2 ring-brand/50': flashed === entry.message._id }"
				:data-message-id="entry.message._id"
				data-testid="answer-team-message"
			>
				<button
					type="button"
					class="flex w-full items-center gap-3 px-4 py-3 text-left"
					:aria-expanded="isOpen(entry.message._id)"
					@click="toggle(entry.message._id)"
				>
					<UiAvatar
						:name="senderName(entry.message) ?? entry.message.from"
						size="sm"
						deterministic-color
					/>
					<span class="min-w-0 flex-1">
						<span class="block truncate text-sm">
							<template v-if="senderName(entry.message)">
								<span class="font-medium text-text-primary">{{ senderName(entry.message) }}</span>
								<span class="ml-1.5 text-xs text-text-tertiary">{{ entry.message.from }}</span>
							</template>
							<span v-else class="font-medium text-text-primary">{{ entry.message.from }}</span>
						</span>
						<span
							v-if="!isOpen(entry.message._id)"
							class="block truncate text-xs text-text-tertiary"
							data-testid="answer-team-message-preview"
						>
							{{ preview(entry.message) }}
						</span>
					</span>
					<time
						class="shrink-0 text-xs text-text-tertiary"
						:datetime="new Date(entry.message._creationTime).toISOString()"
					>
						{{ formatCompactRelativeTime(entry.message._creationTime) }}
					</time>
				</button>
				<div
					v-if="isOpen(entry.message._id)"
					class="px-4 pb-4"
					data-testid="answer-team-message-body"
				>
					<PostboxMessageBody
						v-if="hasInlineBody(entry.message)"
						:message="bodyOf(entry.message)"
					/>
					<InboxMessageBody v-else-if="hasStoredBody(entry.message)" :message="entry.message" />
					<p v-else class="text-sm text-text-tertiary">
						{{ t('dashboard.inbox.detail.noTextContent') }}
					</p>
					<InboxMessageAttachments :message="entry.message" />
				</div>
			</article>

			<InboxThreadOutbound
				v-else-if="entry.kind === 'reply'"
				:author-label="sentReplyAuthor(entry.message)"
				:body="entry.message.draftResponse ?? ''"
				:at="entry.message.processedAt ?? entry.message._creationTime"
				status="sent"
			/>
			<InboxThreadOutbound
				v-else
				:author-label="memberName(entry.followUp.createdBy)"
				:body="entry.followUp.body"
				:at="entry.followUp.sentAt ?? entry.followUp.createdAt"
				:status="entry.followUp.status"
				:send-at="entry.followUp.sendAt"
				:error-message="entry.followUp.errorMessage ?? null"
				:undoing="undoingFollowUpId === entry.followUp._id"
				@undo="emit('undo-follow-up', entry.followUp._id)"
			/>
		</template>
	</div>
</template>
