<script setup lang="ts">
import type { api } from '@owlat/api';
import type { FunctionReturnType } from 'convex/server';
import type { AnswerConversationView } from '~/components/answer/AnswerConversation.vue';
import { formatCompactRelativeTime } from '~/utils/formatters';
import { teamConversationOpenIds } from '~/utils/answerTeamConversation';
import type { TeamStreamEntry } from '../../../../api/convex/mail/interpret/briefShape';
import type { ReplyEntry } from '~/utils/teamStream';
import TeamThreadStream from '~/components/team/TeamThreadStream.vue';

type ThreadData = NonNullable<FunctionReturnType<typeof api.inbox.queries.getThread>>;
type ThreadMessage = ThreadData['messages'][number];
type ThreadContact = ThreadData['contact'];

/**
 * Answer mode's left column for a Team inbox thread (plan §07, SPEC §7): the
 * team stream in its own order. The customer's messages show with their
 * HTML bodies, rendered by the Postbox's sandboxed body component (quotes
 * folded, remote images behind "Show images"; a body too large for its row
 * shows its excerpt, then the full text). The team's replies show as they
 * went out, with their queued or failed state; the team's internal notes and
 * what happened sit between them, read-only here. Older entries load on
 * "Show earlier". The newest message, and the one the reply answers, open in
 * full; older ones are one-line rows; "Full conversation" (`t` on the page)
 * opens them all. The open actions come above (`#open-items`). No summary.
 *
 * Without a stream (still loading, or not readable) the messages alone show.
 * The agent's working, the retry of a failed message and assignment stay on
 * the thread page; this column is only what is being answered.
 */
const props = withDefaults(
	defineProps<{
		messages: readonly ThreadMessage[];
		contact: ThreadContact;
		/** The message the reply answers. */
		answeringId: string | null;
		/** A teammate's display name. */
		memberName: (userId: string) => string;
		undoingFollowUpId?: string | null;
		/** The team stream; undefined until it has loaded. */
		stream?: readonly TeamStreamEntry[];
		hasEarlier?: boolean;
		loadingEarlier?: boolean;
		viewerId?: string | null;
	}>(),
	{
		undoingFollowUpId: null,
		stream: undefined,
		hasEarlier: false,
		loadingEarlier: false,
		viewerId: null,
	}
);

const view = defineModel<AnswerConversationView>('view', { default: 'summary' });
const emit = defineEmits<{
	'undo-follow-up': [followUpId: NonNullable<ReplyEntry['followUpId']>];
	'load-earlier': [];
}>();

const { t } = useI18n();

const messageById = computed(() => new Map(props.messages.map((m) => [m._id as string, m])));
/** The stream, or the messages alone until it is there. */
const entries = computed<TeamStreamEntry[]>(
	() =>
		(props.stream as TeamStreamEntry[] | undefined) ??
		[...props.messages]
			.sort((a, b) => a._creationTime - b._creationTime)
			.map((m) => ({
				kind: 'customerEmail' as const,
				key: `email:${m._id}`,
				at: m._creationTime,
				tie: m._creationTime,
				source: { kind: 'inbound' as const, id: m._id },
				fromEmail: m.from,
				preview: '',
			}))
);
function messageOf(entry: TeamStreamEntry): ThreadMessage | undefined {
	return entry.kind === 'customerEmail' ? messageById.value.get(entry.source.id) : undefined;
}
function undo(entry: ReplyEntry) {
	if (entry.followUpId) emit('undo-follow-up', entry.followUpId);
}
const defaultOpen = computed(() => teamConversationOpenIds(props.messages, props.answeringId));
// Rows a person opened or closed by hand, over the default.
const toggled = ref(new Set<string>());
function isOpen(id: string): boolean {
	if (view.value === 'full') return true;
	return defaultOpen.value.has(id) !== toggled.value.has(id);
}
// A marker elsewhere: open the message, bring it into view, and ring it briefly.
const flashed = ref<string | null>(null);
/** Open, scroll to and ring a message or reply; false while it is not loaded. */
function reveal(id: string): boolean {
	const isShown = entries.value.some((e) =>
		e.kind === 'customerEmail' ? e.source.id === id : e.kind === 'teamReply' && e.source?.id === id
	);
	if (!isShown) return false;
	if (messageById.value.has(id) && !isOpen(id)) toggle(id);
	void nextTick(() => {
		const el = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
		const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
		el?.scrollIntoView?.({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
		flashed.value = id;
		// Reply rows come from the stream component, so ring the element itself too.
		el?.classList.add('ring-2', 'ring-brand/50');
		setTimeout(() => {
			if (flashed.value === id) flashed.value = null;
			el?.classList.remove('ring-2', 'ring-brand/50');
		}, 1600);
	});
	return true;
}
defineExpose({ reveal });
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
					{{ t(`components.team.answer.view.${option === 'summary' ? 'recent' : 'full'}`) }}
				</button>
			</div>
		</div>

		<!-- The open actions, pinned above the conversation. -->
		<slot name="open-items" :view="view" :reveal="reveal" />

		<TeamThreadStream
			:entries="entries"
			:has-earlier="hasEarlier"
			:loading-earlier="loadingEarlier"
			:viewer-id="viewerId"
			:member-name="memberName"
			:can-react="false"
			:undoing-follow-up-id="undoingFollowUpId"
			@load-earlier="emit('load-earlier')"
			@undo-follow-up="undo"
		>
			<template #email="{ entry }">
				<article
					v-if="messageOf(entry)"
					class="rounded-(--radius-card) border border-border-subtle bg-bg-elevated transition-shadow"
					:class="{ 'ring-2 ring-brand/50': flashed === entry.source.id }"
					:data-message-id="entry.source.id"
					:data-answer-anchor="entry.source.id === answeringId ? '' : undefined"
					data-testid="answer-team-message"
				>
					<button
						type="button"
						class="flex w-full items-center gap-3 px-4 py-3 text-left"
						:aria-expanded="isOpen(entry.source.id)"
						@click="toggle(entry.source.id)"
					>
						<UiAvatar
							:name="senderName(messageOf(entry)!) ?? messageOf(entry)!.from"
							size="sm"
							deterministic-color
						/>
						<span class="min-w-0 flex-1">
							<span class="block truncate text-sm">
								<template v-if="senderName(messageOf(entry)!)">
									<span class="font-medium text-text-primary">{{
										senderName(messageOf(entry)!)
									}}</span>
									<span class="ml-1.5 text-xs text-text-tertiary">{{
										messageOf(entry)!.from
									}}</span>
								</template>
								<span v-else class="font-medium text-text-primary">{{
									messageOf(entry)!.from
								}}</span>
							</span>
							<span
								v-if="!isOpen(entry.source.id)"
								class="block truncate text-xs text-text-tertiary"
								data-testid="answer-team-message-preview"
							>
								{{ preview(messageOf(entry)!) }}
							</span>
						</span>
						<time
							class="shrink-0 text-xs text-text-tertiary"
							:datetime="new Date(messageOf(entry)!._creationTime).toISOString()"
						>
							{{ formatCompactRelativeTime(messageOf(entry)!._creationTime) }}
						</time>
					</button>
					<div
						v-if="isOpen(entry.source.id)"
						class="px-4 pb-4"
						data-testid="answer-team-message-body"
					>
						<PostboxMessageBody
							v-if="hasInlineBody(messageOf(entry)!)"
							:message="bodyOf(messageOf(entry)!)"
						/>
						<InboxMessageBody
							v-else-if="hasStoredBody(messageOf(entry)!)"
							:message="messageOf(entry)!"
						/>
						<p v-else class="text-sm text-text-tertiary">
							{{ t('dashboard.inbox.detail.noTextContent') }}
						</p>
						<InboxMessageAttachments :message="messageOf(entry)!" />
					</div>
				</article>
				<article
					v-else
					class="rounded-(--radius-card) bg-bg-surface px-4 py-3 text-sm text-text-secondary"
					data-testid="answer-team-message"
				>
					<span class="font-medium text-text-primary">{{ entry.fromName ?? entry.fromEmail }}</span>
					· {{ entry.preview }}
				</article>
			</template>
		</TeamThreadStream>
	</div>
</template>
