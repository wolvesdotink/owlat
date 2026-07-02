<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { ReplyQuoteTarget } from '~/composables/postbox/usePostboxQuotedText';
import {
	replyQueueHeadline,
	formatReplyQueueDueHint,
	type ReplyQueueItem,
} from '~/utils/postboxReplyQueue';
import { formatThreadTimestamp } from '~/composables/postbox/usePostboxThreads';

/**
 * The Reply Queue — a task list of emails waiting on the user's reply.
 *
 * Each needs-reply thread renders as a row-card: sender + avatar, the AI's
 * askSummary as the headline (subject fallback when AI is off/failed), an
 * optional due chip, the thread snippet, and Open / Draft reply / Done /
 * Snooze actions. Rows clear live: replying or archiving anywhere unsets the
 * server-side flag and the subscription drops the row. Keyboard: j/k move,
 * Enter opens, e archives, h snoozes (usePostboxListKeyboard).
 */
const props = defineProps<{ mailboxId: Id<'mailboxes'> }>();

const mailboxIdRef = computed(() => props.mailboxId as Id<'mailboxes'> | null);
const { items, isLoading } = usePostboxReplyQueue(mailboxIdRef);

// Keyboard + optimistic-hide plumbing expects `_id` rows; key by thread (one
// queue row per thread).
type QueueRow = ReplyQueueItem & { _id: string };
const rows = computed<QueueRow[]>(() => items.value.map((i) => ({ ...i, _id: i.threadId })));
const { visible: visibleRows, hide: hideRow, unhide: unhideRow } = usePostboxOptimisticHide(rows);

const { isEnabled: isFeatureEnabled } = useFeatureFlag();
const aiEnabled = computed(() => isFeatureEnabled('ai'));

const stack = usePostboxComposerStack();

const clearOp = useBackendOperation(api.mail.needsReply.clear, { label: 'Mark done' });
const archiveOp = useBackendOperation(api.mail.messageActions.archive, { label: 'Archive' });
const snoozeOp = useBackendOperation(api.mail.snooze.snooze, { label: 'Snooze' });
const suggestOp = useBackendOperation(api.mail.ai.suggestReplies, {
	label: 'Draft reply',
	type: 'action',
});

/** Manual "Done" — clear the flag; the row hides instantly, restored on failure. */
async function markDone(row: QueueRow) {
	hideRow(row._id);
	const result = await clearOp.run({ threadId: row.threadId as Id<'mailThreads'> });
	if (result === undefined) unhideRow(row._id);
}

/** e — archive the flagged message (the move also clears the flag server-side). */
async function archiveRow(row: QueueRow) {
	hideRow(row._id);
	const result = await archiveOp.run({ messageIds: [row.messageId as Id<'mailMessages'>] });
	if (result === undefined) unhideRow(row._id);
}

// h / Snooze button — the target is captured so a focus change while the
// dialog is open can't retarget the action (same policy as the thread list).
const snoozeOpen = ref(false);
const snoozeTarget = ref<QueueRow | null>(null);

function openSnooze(row: QueueRow) {
	snoozeTarget.value = row;
	snoozeOpen.value = true;
}
async function confirmSnooze(until: number) {
	const row = snoozeTarget.value;
	snoozeTarget.value = null;
	if (!row) return;
	hideRow(row._id);
	const result = await snoozeOp.run({
		messageId: row.messageId as Id<'mailMessages'>,
		until,
	});
	if (result === undefined) unhideRow(row._id);
}

function openRow(row: QueueRow) {
	// The message may have been triaged out of the inbox; the reader's
	// deep-link fallback fetches it by id regardless of the folder segment.
	void navigateTo(`/dashboard/postbox/inbox/${row.messageId}`);
}

/**
 * "Draft reply": ask the existing suggest-replies action for a starter and
 * open the composer prefilled above the quoted original — the same shape the
 * reader's openReplyWithBody produces. Fail-soft: any AI/gate failure still
 * opens a plain reply composer (empty body over the quote).
 */
const draftingThreadId = ref<string | null>(null);

async function draftReply(row: QueueRow) {
	if (draftingThreadId.value) return;
	draftingThreadId.value = row.threadId;
	try {
		let suggestion = '';
		if (aiEnabled.value) {
			const res = await suggestOp.run({ messageId: row.messageId as Id<'mailMessages'> });
			suggestion = res?.replies[0] ?? '';
		}
		await openReplyComposer(row, suggestion);
	} finally {
		draftingThreadId.value = null;
	}
}

/**
 * Fetch the original (body included) and open a prefilled reply composer via
 * the same resolveBodyFields + buildReplySpec seam the thread reader uses.
 */
async function openReplyComposer(row: QueueRow, bodyText: string) {
	const messageId = row.messageId as Id<'mailMessages'>;
	// The queue row carries headers but no body — fetch the full message first
	// (fall through with the row's fields on failure; the composer still opens).
	let target: ReplyQuoteTarget = { ...row, _id: row.messageId };
	try {
		const message = await requireConvex().query(api.mail.mailbox.getMessage, { messageId });
		if (message) target = message;
		target = await resolveBodyFields(target);
	} catch {
		// Fall through with the queue row's fields — the composer still opens.
	}
	stack.open(buildReplySpec(props.mailboxId, target, bodyText));
}

const {
	focusedIndex,
	activeId: activeRowId,
	onKeydown: onListKeydown,
} = usePostboxListKeyboard({
	items: visibleRows,
	resetKey: computed(() => props.mailboxId),
	rowDomId: (row) => `reply-queue-row-${row._id}`,
	onActivate: (row) => openRow(row),
	onAction: (key, row) => {
		switch (resolvePostboxShortcut(key)) {
			case 'archive':
				void archiveRow(row);
				break;
			case 'snooze':
				openSnooze(row);
				break;
		}
	},
});

const URGENCY_LABEL: Record<string, string> = { high: 'Urgent', low: 'Low priority' };
</script>

<template>
	<div v-if="isLoading && visibleRows.length === 0" class="p-8 text-center">
		<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin text-text-tertiary mx-auto" />
	</div>
	<!-- Quiet inbox-zero moment when the queue empties. -->
	<PostboxEmptyState
		v-else-if="visibleRows.length === 0"
		icon="lucide:check-circle-2"
		title="All caught up"
		hint="Nothing is waiting on your reply."
	/>
	<ul
		v-else
		tabindex="0"
		role="listbox"
		aria-label="Reply queue"
		:aria-activedescendant="activeRowId"
		class="divide-y divide-border-subtle outline-none focus-visible:ring-1 focus-visible:ring-brand/40 focus-visible:ring-inset"
		@keydown="onListKeydown"
	>
		<li v-for="(row, i) in visibleRows" :key="row._id" class="group relative">
			<div
				:id="`reply-queue-row-${row._id}`"
				role="option"
				:aria-selected="focusedIndex === i"
				class="flex items-start gap-3 px-4 py-3 hover:bg-bg-elevated cursor-pointer"
				:class="{ 'ring-1 ring-inset ring-brand/50': focusedIndex === i }"
				@click="openRow(row)"
			>
				<UiAvatar
					:name="row.fromName"
					:email="row.fromAddress"
					deterministic-color
					size="sm"
					class="flex-shrink-0 mt-0.5"
					aria-hidden="true"
				/>
				<div class="flex-1 min-w-0">
					<div class="flex items-baseline justify-between gap-3">
						<span class="truncate text-sm text-text-secondary">
							{{ row.fromName || row.fromAddress }}
						</span>
						<span class="text-xs text-text-tertiary flex-shrink-0">
							{{ formatThreadTimestamp(row.receivedAt) }}
						</span>
					</div>
					<div class="flex items-center gap-1.5 mt-0.5">
						<span
							v-if="row.urgency !== 'normal'"
							class="flex-shrink-0 text-[10px] font-medium uppercase tracking-wide px-1.5 py-px rounded-full"
							:class="row.urgency === 'high' ? 'bg-error/10 text-error' : 'bg-bg-elevated text-text-tertiary'"
						>{{ URGENCY_LABEL[row.urgency] }}</span>
						<p class="truncate text-sm font-medium text-text-primary flex-1">
							{{ replyQueueHeadline(row) }}
						</p>
						<span
							v-if="formatReplyQueueDueHint(row.dueHint)"
							class="flex-shrink-0 text-[10px] font-medium px-1.5 py-px rounded-full bg-warning/10 text-warning"
						>{{ formatReplyQueueDueHint(row.dueHint) }}</span>
					</div>
					<p class="text-xs text-text-tertiary truncate mt-0.5">{{ row.snippet }}</p>
				</div>
			</div>
			<!-- Hover / focus actions -->
			<div
				class="absolute right-3 top-1/2 -translate-y-1/2 hidden group-hover:flex group-focus-within:flex items-center gap-0.5 bg-bg-elevated/95 rounded px-1 py-0.5 shadow-sm border border-border-subtle"
			>
				<button
					v-if="aiEnabled"
					type="button"
					class="inline-flex items-center gap-1 px-1.5 py-1 rounded text-xs hover:bg-bg-surface text-text-tertiary hover:text-text-primary disabled:opacity-50"
					title="Draft reply"
					aria-label="Draft reply"
					:disabled="draftingThreadId !== null"
					@click.stop.prevent="draftReply(row)"
				>
					<Icon
						:name="draftingThreadId === row.threadId ? 'lucide:loader-2' : 'lucide:wand-2'"
						class="w-4 h-4"
						:class="{ 'animate-spin': draftingThreadId === row.threadId }"
					/>
				</button>
				<button
					v-else
					type="button"
					class="p-1 rounded hover:bg-bg-surface text-text-tertiary hover:text-text-primary"
					title="Reply"
					aria-label="Reply"
					@click.stop.prevent="draftReply(row)"
				>
					<Icon name="lucide:reply" class="w-4 h-4" />
				</button>
				<button
					type="button"
					class="p-1 rounded hover:bg-bg-surface text-text-tertiary hover:text-text-primary"
					title="Snooze"
					aria-label="Snooze"
					@click.stop.prevent="openSnooze(row)"
				>
					<Icon name="lucide:clock" class="w-4 h-4" />
				</button>
				<button
					type="button"
					class="p-1 rounded hover:bg-bg-surface text-text-tertiary hover:text-success"
					title="Done — clear from queue"
					aria-label="Done"
					data-testid="reply-queue-done"
					@click.stop.prevent="markDone(row)"
				>
					<Icon name="lucide:check" class="w-4 h-4" />
				</button>
			</div>
		</li>
	</ul>

	<PostboxSnoozeDialog
		:open="snoozeOpen"
		@update:open="snoozeOpen = $event"
		@confirm="confirmSnooze"
	/>
</template>
