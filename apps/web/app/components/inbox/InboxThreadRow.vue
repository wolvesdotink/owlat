<script lang="ts">
/**
 * One Team Inbox thread-list row's projection — the fields `listThreads`
 * returns that this row renders. Kept here so the list and the row agree on the
 * shape.
 */
export interface InboxThreadRowThread {
	_id: string;
	_creationTime: number;
	subject: string;
	contactIdentifier: string;
	status: 'open' | 'waiting' | 'resolved' | 'closed';
	latestDraftStatus?: 'pending' | 'approved' | 'rejected' | 'sent' | null;
	snoozedUntil?: number | null;
	snoozeReturnedAt?: number | null;
	lastMessageAt?: number | null;
	messageCount?: number;
	/** Non-email origin ('sms' / 'whatsapp' / …); absent/email → no channel chip. */
	channel?: string | null;
	/** Denormalized newest-message preview. */
	lastPreview?: string | null;
	/** Newer activity than this viewer's last-seen marker. */
	unread?: boolean;
	/** Assigned member, resolved for the avatar (null when unassigned). */
	assignee?: { name?: string; email: string; image?: string | null } | null;
	/** The assignee currently has the thread open (drives the presence ring). */
	assigneePresent?: boolean;
}
</script>

<script setup lang="ts">
/**
 * A single Team Inbox thread row, built on the shared PostboxRowCore so it reads
 * with the same craft as the Postbox message list: avatar, weight-based unread
 * emphasis, ONE roll-up status chip, an optional channel chip, a snippet line,
 * the assignee avatar with a live presence ring, a tabular-nums relative time,
 * and an opacity-only hover-reveal quick-action cluster (assign / resolve /
 * snooze / open). The list owns the v-for, keyboard navigation, and every
 * mutation; this row maps DOM events to semantic emits.
 */
const props = defineProps<{
	thread: InboxThreadRowThread;
	/** Keyboard-focused row (drives the focus ring + aria-selected). */
	focused: boolean;
	/** Shared relative-time formatter from useInbox. */
	formatRelativeTime: (timestamp: number) => string;
}>();

const emit = defineEmits<{
	assign: [];
	resolve: [];
	snooze: [];
	open: [];
}>();

const rowId = computed(() => `inbox-row-${props.thread._id}`);

const timestamp = computed(() => props.thread.lastMessageAt ?? props.thread._creationTime);

/** Channel chip only for non-email threads. */
const showChannelChip = computed(() => !!props.thread.channel && props.thread.channel !== 'email');
const channelLabel = computed(() => {
	const c = props.thread.channel ?? '';
	if (c === 'sms') return 'SMS';
	if (c === 'whatsapp') return 'WhatsApp';
	return c.charAt(0).toUpperCase() + c.slice(1);
});

const assigneeName = computed(() => {
	const a = props.thread.assignee;
	return a ? a.name || a.email : null;
});

/** Stop a hover-action button from following the row's NuxtLink. */
function rowAction(event: MouseEvent, action: 'assign' | 'resolve' | 'snooze') {
	event.stopPropagation();
	event.preventDefault();
	switch (action) {
		case 'assign':
			emit('assign');
			break;
		case 'resolve':
			emit('resolve');
			break;
		case 'snooze':
			emit('snooze');
			break;
	}
}
</script>

<template>
	<li class="group relative">
		<NuxtLink
			:id="rowId"
			role="option"
			:aria-selected="focused"
			:to="`/dashboard/inbox/${thread._id}`"
			class="block w-full text-left px-4 py-3 rounded-lg hover:bg-(--surface-1-hover) transition-colors"
			:class="{ 'ring-1 ring-inset ring-brand/50': focused }"
			@click="emit('open')"
		>
			<div class="flex items-start gap-3">
				<!-- Unread dot — weight-based emphasis lives on the identifier; the dot
				     is a small brand indicator, the one sanctioned accent use. -->
				<span class="mt-1.5 w-2 flex-shrink-0" aria-hidden="true">
					<span v-if="thread.unread" class="block w-2 h-2 rounded-full bg-brand" title="Unread" />
				</span>

				<PostboxRowCore :unread="thread.unread">
					<template #identifier>{{ thread.subject || 'No subject' }}</template>
					<template #meta>{{ formatRelativeTime(timestamp) }}</template>

					<!-- Detail row: sender + the single status chip + optional channel chip. -->
					<div class="flex items-center gap-2 mt-0.5 min-w-0">
						<span class="truncate text-sm text-text-secondary">
							{{ thread.contactIdentifier || 'Unknown sender' }}
						</span>
						<InboxStatusChip
							class="flex-shrink-0"
							:status="thread.status"
							:latest-draft-status="thread.latestDraftStatus"
							:snoozed-until="thread.snoozedUntil"
							:snooze-returned-at="thread.snoozeReturnedAt"
						/>
						<span
							v-if="showChannelChip"
							class="flex-shrink-0 inline-flex items-center gap-1 text-xs text-text-tertiary"
						>
							<Icon name="lucide:message-circle" class="w-3 h-3" />
							{{ channelLabel }}
						</span>
					</div>

					<!-- Snippet line — newest-message preview (denormalized). -->
					<p class="text-xs text-text-tertiary truncate mt-0.5">
						{{ thread.lastPreview || ' ' }}
					</p>
				</PostboxRowCore>

				<!-- Assignee avatar + live presence ring, right-aligned. -->
				<span
					v-if="thread.assignee"
					class="flex-shrink-0 mt-0.5"
					:title="`Assigned to ${assigneeName}`"
				>
					<span :class="thread.assigneePresent ? 'ui-presence-ring' : ''">
						<UiAvatar
							:name="assigneeName ?? undefined"
							:email="thread.assignee.email"
							:image="thread.assignee.image ?? undefined"
							deterministic-color
							size="sm"
						/>
					</span>
				</span>
			</div>
		</NuxtLink>

		<!-- Hover-reveal quick actions (opacity-only, focus-within reveals for
		     keyboard) — single-thread triage without opening the thread. -->
		<div
			class="ui-hover-reveal absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-0.5 bg-bg-elevated/95 rounded px-1 py-0.5 shadow-sm border border-border-subtle"
		>
			<button
				type="button"
				class="p-1 rounded hover:bg-bg-surface text-text-tertiary hover:text-brand"
				title="Assign to me"
				aria-label="Assign to me"
				@click="rowAction($event, 'assign')"
			>
				<Icon name="lucide:user-plus" class="w-4 h-4" />
			</button>
			<button
				type="button"
				class="p-1 rounded hover:bg-bg-surface text-text-tertiary hover:text-success"
				title="Resolve"
				aria-label="Resolve"
				@click="rowAction($event, 'resolve')"
			>
				<Icon name="lucide:check-circle" class="w-4 h-4" />
			</button>
			<button
				type="button"
				class="p-1 rounded hover:bg-bg-surface text-text-tertiary hover:text-text-primary"
				title="Snooze"
				aria-label="Snooze"
				@click="rowAction($event, 'snooze')"
			>
				<Icon name="lucide:clock" class="w-4 h-4" />
			</button>
			<NuxtLink
				:to="`/dashboard/inbox/${thread._id}`"
				class="p-1 rounded hover:bg-bg-surface text-text-tertiary hover:text-text-primary inline-flex"
				title="Open"
				aria-label="Open thread"
				@click.stop
			>
				<Icon name="lucide:arrow-right" class="w-4 h-4" />
			</NuxtLink>
		</div>
	</li>
</template>
