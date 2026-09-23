<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { formatCompactRelativeTime } from '~/utils/formatters';

/**
 * The reader's "Team discussion": an internal chat thread bound to this email
 * thread (`chat.mailDiscussion`), visible to the people who can read the
 * mailbox and never sent to the correspondent.
 *
 * It must never be mistaken for the reply box, so it sits on its own soft
 * panel with an "internal" pill, and the composer says whom it is NOT writing
 * to. Renders nothing when chat is off, when the panel is closed, or when the
 * backend reports no access (the query answers null).
 *
 * Beside the conversation when the reader pane is wide (the reader's
 * `<article>` turns into a two-column grid, see
 * `usePostboxThreadDiscussionPanel`), below it otherwise; `grid-row: 1 / span
 * 50` keeps every other child of the article in the first column. `@handle` mentions are parsed server-side, so a mentioned
 * teammate gets it in their mentions feed.
 */
const props = defineProps<{
	threadId: string;
	mailboxId: string;
	/** Name or address of the external correspondent, for the composer placeholder. */
	counterpartyLabel?: string;
}>();

const { t } = useI18n();
const { isOpen, toggle } = usePostboxThreadDiscussionPanel();
const { discussion, count } = usePostboxThreadDiscussionData(() => props.threadId);

const { run: postRun, isLoading: isPosting } = useBackendOperation(api.chat.mailDiscussion.post, {
	label: () => t('components.postbox.threadDiscussion.sendOperation'),
	announce: false,
});
const { run: markReadRun } = useBackendOperation(api.chat.mailDiscussion.markRead, {
	label: () => t('components.postbox.threadDiscussion.markReadOperation'),
	announce: false,
});

const isVisible = computed(() => isOpen.value && discussion.value !== null);
const messages = computed(() => discussion.value?.messages ?? []);

const draft = ref('');
const canSend = computed(() => draft.value.trim().length > 0 && !isPosting.value);

const placeholder = computed(() =>
	props.counterpartyLabel
		? t('components.postbox.threadDiscussion.placeholder', {
				counterparty: props.counterpartyLabel,
			})
		: t('components.postbox.threadDiscussion.placeholderNoCounterparty')
);

async function send() {
	const body = draft.value.trim();
	if (!body || isPosting.value) return;
	const outcome = await postRun({ threadId: props.threadId as Id<'mailThreads'>, body });
	if (outcome.ok) draft.value = '';
}

function onKeydown(event: KeyboardEvent) {
	if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
	event.preventDefault();
	void send();
}

// Opening a thread's discussion clears the caller's unread @mentions in it —
// once per thread, and only when a room exists to hold any.
const markedThreads = new Set<string>();
watch(
	() => (isVisible.value && discussion.value?.roomId ? props.threadId : null),
	(threadId) => {
		if (!threadId || markedThreads.has(threadId)) return;
		markedThreads.add(threadId);
		void markReadRun({ threadId: threadId as Id<'mailThreads'> });
	},
	{ immediate: true }
);

// A draft belongs to the thread (and mailbox) it was written under.
watch(
	() => `${props.mailboxId}:${props.threadId}`,
	() => {
		draft.value = '';
	}
);

const listEl = ref<HTMLElement | null>(null);
watch(
	() => messages.value.length,
	() => nextTick(() => listEl.value?.scrollTo({ top: listEl.value.scrollHeight })),
	{ immediate: true }
);
</script>

<template>
	<aside
		v-if="isVisible"
		class="pbx-thread-discussion mt-6 flex flex-col rounded-xl border border-dashed border-border-default bg-bg-soft @min-[52rem]:mt-0 @min-[52rem]:col-start-2 @min-[52rem]:[grid-row:1/span_50] @min-[52rem]:sticky @min-[52rem]:top-4 @min-[52rem]:max-h-[calc(100vh-7rem)]"
		:aria-label="t('components.postbox.threadDiscussion.regionLabel')"
		data-testid="thread-discussion"
	>
		<header class="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
			<Icon name="lucide:messages-square" class="w-4 h-4 text-text-tertiary" aria-hidden="true" />
			<h2 class="text-sm font-medium text-text-primary">
				{{ t('components.postbox.threadDiscussion.title') }}
			</h2>
			<span
				class="rounded-full bg-warning-subtle px-2 py-0.5 text-2xs font-medium uppercase tracking-wide text-warning"
			>
				{{ t('components.postbox.threadDiscussion.internal') }}
			</span>
			<span
				class="text-xs text-text-tertiary"
				:title="t('components.postbox.threadDiscussion.count', { count })"
				data-testid="thread-discussion-count"
			>
				· {{ count }}
			</span>
			<button
				type="button"
				class="ml-auto rounded p-1 text-text-tertiary hover:bg-bg-surface-hover hover:text-text-primary focus-visible:ring-1 focus-visible:ring-brand/40 outline-none"
				:aria-label="t('components.postbox.threadDiscussion.close')"
				:title="t('components.postbox.threadDiscussion.close')"
				@click="toggle"
			>
				<Icon name="lucide:x" class="w-4 h-4" aria-hidden="true" />
			</button>
		</header>

		<div ref="listEl" class="flex-1 min-h-0 overflow-y-auto px-4 py-3">
			<p
				v-if="messages.length === 0"
				class="py-6 text-center text-sm text-text-tertiary"
				data-testid="thread-discussion-empty"
			>
				{{ t('components.postbox.threadDiscussion.empty') }}
			</p>
			<ol v-else class="space-y-3">
				<li
					v-for="message in messages"
					:key="message._id"
					class="flex gap-2"
					data-testid="thread-discussion-message"
				>
					<UiAvatar
						:name="message.authorName"
						:image="message.authorImage"
						size="sm"
						class="mt-0.5 flex-shrink-0"
					/>
					<div class="min-w-0 flex-1">
						<div class="flex items-baseline gap-2">
							<span class="truncate text-xs font-medium text-text-primary">
								{{ message.authorName || t('components.postbox.threadDiscussion.unknownAuthor') }}
							</span>
							<time
								class="flex-shrink-0 text-2xs text-text-tertiary"
								:datetime="new Date(message.createdAt).toISOString()"
							>
								{{ formatCompactRelativeTime(message.createdAt) }}
							</time>
						</div>
						<p
							class="mt-0.5 whitespace-pre-wrap break-words rounded-lg px-2.5 py-1.5 text-sm text-text-primary"
							:class="message.isMine ? 'bg-brand-subtle' : 'bg-bg-surface'"
						>
							{{ message.body }}
						</p>
					</div>
				</li>
			</ol>
		</div>

		<form class="border-t border-border-subtle px-3 py-3" @submit.prevent="send">
			<textarea
				v-model="draft"
				rows="2"
				class="w-full resize-none rounded-lg border border-border-subtle bg-bg-base px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:border-brand-border focus:outline-none"
				:placeholder="placeholder"
				:aria-label="t('components.postbox.threadDiscussion.composerLabel')"
				data-testid="thread-discussion-input"
				@keydown="onKeydown"
			/>
			<div class="mt-2 flex items-center gap-2">
				<span class="flex-1 text-2xs text-text-tertiary">
					{{ t('components.postbox.threadDiscussion.hint') }}
				</span>
				<UiButton
					type="submit"
					size="sm"
					variant="secondary"
					:disabled="!canSend"
					:loading="isPosting"
					data-testid="thread-discussion-send"
				>
					{{ t('components.postbox.threadDiscussion.send') }}
				</UiButton>
			</div>
		</form>
	</aside>
</template>
