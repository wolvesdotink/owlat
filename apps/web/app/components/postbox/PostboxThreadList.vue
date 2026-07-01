<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { PostboxComposeMode, PostboxPendingCompose } from '~/utils/postboxShortcuts';

const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	messages: Array<{
		_id: string;
		fromAddress: string;
		fromName?: string;
		subject: string;
		snippet: string;
		receivedAt: number;
		flagSeen: boolean;
		flagFlagged: boolean;
		hasAttachments: boolean;
		snoozedUntil?: number;
	}>;
	loading: boolean;
	folderRole: string;
	activeMessageId?: string | null;
	hasMore?: boolean;
	// When set, clicking a row (or pressing Enter) emits `select` for in-place
	// preview instead of navigating to the folder/message route. Used by the
	// search results screen, which previews hits in its own right-hand pane
	// rather than ejecting the user into the three-pane folder view.
	selectable?: boolean;
}>();

const emit = defineEmits<{
	(e: 'load-more'): void;
	(e: 'select', messageId: string): void;
}>();

const mailboxIdRef = computed(() => props.mailboxId);
const bulk = usePostboxBulkActions(mailboxIdRef);

function onCheckboxClick(event: MouseEvent, messageId: string) {
	event.stopPropagation();
	event.preventDefault();
	bulk.toggle(messageId as unknown as Id<'mailMessages'>);
}

const mid = (id: string) => id as unknown as Id<'mailMessages'>;

const archiveOp = useBackendOperation(api.mail.messageActions.archive, { label: 'Archive' });
const trashOp = useBackendOperation(api.mail.messageActions.trash, { label: 'Move to trash' });
const setStarOp = useBackendOperation(api.mail.messageActions.setStar, { label: 'Star' });
const markReadOp = useBackendOperation(api.mail.messageActions.markRead, { label: 'Mark read' });

// Optimistic row removal — hide on archive/trash, restore on failure (see
// usePostboxOptimisticHide).
const messagesRef = computed(() => props.messages);
const { visible: visibleMessages, hide: hideRow, unhide: unhideRow } =
	usePostboxOptimisticHide(messagesRef);

// Visual row order for the reader's auto-advance (PostboxLayout reads this
// via a template ref): the optimistic-hide-filtered list as rendered.
const visibleIds = computed(() => visibleMessages.value.map((m) => m._id));
defineExpose({ visibleIds });

// Successful triage registers its inverse for the "Undo — Cmd+Z" toast;
// undoing also un-hides the optimistically hidden row.
const triageUndo = usePostboxTriageUndo();

async function archiveMsg(id: string) {
	hideRow(id);
	// archive/trash return { ok, moved } — restore the row if the mutation failed.
	const result = await archiveOp.run({ messageIds: [mid(id)] });
	if (!result) {
		unhideRow(id);
		return;
	}
	if (result.moved.length > 0) {
		triageUndo.registerMoveBack({
			label: 'Archived',
			moved: result.moved,
			runMove: (a) => moveOp.run(a),
			after: () => unhideRow(id),
		});
	}
}
async function trashMsg(id: string) {
	hideRow(id);
	const result = await trashOp.run({ messageIds: [mid(id)] });
	if (!result) {
		unhideRow(id);
		return;
	}
	if (result.moved.length > 0) {
		triageUndo.registerMoveBack({
			label: 'Moved to Trash',
			moved: result.moved,
			runMove: (a) => moveOp.run(a),
			after: () => unhideRow(id),
		});
	}
}
function toggleStar(id: string, starred: boolean) {
	void setStarOp.run({ messageId: mid(id), starred });
}
function toggleRead(id: string, seen: boolean) {
	void markReadOp.run({ messageId: mid(id), seen });
}

/** Stop a hover-action button from following the row's NuxtLink. */
function rowAction(event: MouseEvent, fn: () => void) {
	event.stopPropagation();
	event.preventDefault();
	fn();
}

// Pending compose intent for r/a/f from the list: opening the composer needs
// the reader's quoting/recipient logic, so we open the message first and let
// PostboxThreadReader consume the intent once it renders that message.
const pendingCompose = useState<PostboxPendingCompose | null>(
	POSTBOX_PENDING_COMPOSE_KEY,
	() => null
);

function openMessageWithCompose(id: string, mode: PostboxComposeMode) {
	pendingCompose.value = { messageId: id, mode };
	if (props.selectable) emit('select', id);
	else void navigateTo(`/dashboard/postbox/${props.folderRole}/${id}`);
}

// h/l/v open a picker for the focused row; the target id is captured so a
// focus change while the dialog is open can't retarget the action.
const snoozeOpen = ref(false);
const snoozeTargetId = ref<string | null>(null);
const labelOpen = ref(false);
const labelTargetId = ref<string | null>(null);
const moveOpen = ref(false);
const moveTargetId = ref<string | null>(null);

const { labels, setOnMessage } = usePostboxLabels(mailboxIdRef);
const { folders } = usePostboxFolders(mailboxIdRef);
// Same destination filter as PostboxQuickActionsBar: moving a received
// message into Sent/Drafts mis-frames it, and the current folder is a no-op.
const movableFolders = computed(() =>
	folders.value.filter((f) => {
		if (f.role === 'sent' || f.role === 'drafts') return false;
		if (f.role === props.folderRole) return false;
		return true;
	})
);

const snoozeOp = useBackendOperation(api.mail.snooze.snooze, { label: 'Snooze' });
const moveOp = useBackendOperation(api.mail.messageActions.move, { label: 'Move message' });

async function snoozeFocused(until: number) {
	const id = snoozeTargetId.value;
	snoozeTargetId.value = null;
	if (!id) return;
	hideRow(id);
	if ((await snoozeOp.run({ messageId: mid(id), until })) === undefined) unhideRow(id);
}

async function applyLabelToFocused(labelId: Id<'mailLabels'>) {
	const id = labelTargetId.value;
	labelOpen.value = false;
	labelTargetId.value = null;
	if (id) await setOnMessage(mid(id), labelId, true);
}

async function moveFocusedTo(targetFolderId: Id<'mailFolders'>) {
	const id = moveTargetId.value;
	moveOpen.value = false;
	moveTargetId.value = null;
	if (!id) return;
	hideRow(id);
	const result = await moveOp.run({ messageIds: [mid(id)], targetFolderId });
	if (result === undefined) {
		unhideRow(id);
		return;
	}
	if (result.moved.length > 0) {
		triageUndo.registerMoveBack({
			label: 'Moved',
			moved: result.moved,
			runMove: (a) => moveOp.run(a),
			after: () => unhideRow(id),
		});
	}
}

// Keyboard triage (Gmail/Superhuman-style): j/k move, Enter opens; single-key
// actions resolve via utils/postboxShortcuts.ts (e archive, # delete, s star,
// u toggle read, Shift+U unread, x select, r/a/f compose, h/l/v pickers).
// Focus survives live updates (see composable).
const {
	focusedIndex,
	activeId: activeRowId,
	onKeydown: onListKeydown,
} = usePostboxListKeyboard({
	items: visibleMessages,
	resetKey: computed(() => props.folderRole),
	rowDomId: (m) => `postbox-row-${m._id}`,
	onActivate: (m) =>
		props.selectable
			? emit('select', m._id)
			: void navigateTo(`/dashboard/postbox/${props.folderRole}/${m._id}`),
	onAction: (key, m) => {
		switch (resolvePostboxShortcut(key)) {
			case 'archive':
				void archiveMsg(m._id);
				break;
			case 'trash':
				void trashMsg(m._id);
				break;
			case 'star':
				toggleStar(m._id, !m.flagFlagged);
				break;
			case 'toggleRead':
				toggleRead(m._id, !m.flagSeen);
				break;
			case 'markUnread':
				toggleRead(m._id, false);
				break;
			case 'toggleSelect':
				bulk.toggle(mid(m._id));
				break;
			case 'reply':
				openMessageWithCompose(m._id, 'reply');
				break;
			case 'replyAll':
				openMessageWithCompose(m._id, 'replyAll');
				break;
			case 'forward':
				openMessageWithCompose(m._id, 'forward');
				break;
			case 'snooze':
				snoozeTargetId.value = m._id;
				snoozeOpen.value = true;
				break;
			case 'label':
				labelTargetId.value = m._id;
				labelOpen.value = true;
				break;
			case 'move':
				moveTargetId.value = m._id;
				moveOpen.value = true;
				break;
			// 'help' is handled by the window-level PostboxShortcutHelp listener.
		}
	},
});
</script>

<template>
	<div v-if="loading" class="p-6 flex justify-center">
		<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin text-text-tertiary" />
	</div>
	<div v-else-if="visibleMessages.length === 0" class="p-12 text-center">
		<Icon name="lucide:inbox" class="w-10 h-10 mx-auto text-text-tertiary" />
		<p class="text-sm text-text-secondary mt-3">No messages</p>
	</div>
	<ul
		v-else
		tabindex="0"
		role="listbox"
		aria-label="Messages"
		:aria-activedescendant="activeRowId"
		class="divide-y divide-border-subtle outline-none focus-visible:ring-1 focus-visible:ring-brand/40 focus-visible:ring-inset"
		@keydown="onListKeydown"
	>
		<li
			v-for="(msg, i) in visibleMessages"
			:key="msg._id"
			class="group relative"
			style="content-visibility: auto; contain-intrinsic-size: auto 76px"
		>
			<component
				:is="selectable ? 'div' : (resolveComponent('NuxtLink') as 'div')"
				:id="`postbox-row-${msg._id}`"
				role="option"
				:tabindex="selectable ? -1 : undefined"
				:aria-selected="focusedIndex === i"
				:to="selectable ? undefined : `/dashboard/postbox/${props.folderRole}/${msg._id}`"
				class="block w-full text-left px-4 py-3 hover:bg-bg-elevated"
				:class="{
					'bg-bg-elevated': activeMessageId === msg._id,
					'bg-brand/5': bulk.isSelected(msg._id as unknown as Id<'mailMessages'>),
					'ring-1 ring-inset ring-brand/50': focusedIndex === i,
					'cursor-pointer': selectable,
				}"
				@click="selectable ? emit('select', msg._id) : undefined"
			>
				<div class="flex items-start gap-2">
					<button
						type="button"
						class="mt-0.5 w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center"
						:class="
							bulk.isSelected(msg._id as unknown as Id<'mailMessages'>)
								? 'bg-brand border-brand text-white'
								: 'border-border-subtle bg-bg-base opacity-0 group-hover:opacity-100'
						"
						:aria-label="bulk.isSelected(msg._id as unknown as Id<'mailMessages'>) ? 'Deselect' : 'Select'"
						@click="onCheckboxClick($event, msg._id)"
					>
						<Icon
							v-if="bulk.isSelected(msg._id as unknown as Id<'mailMessages'>)"
							name="lucide:check"
							class="w-3 h-3"
						/>
					</button>
					<div class="flex-1 min-w-0">
						<div class="flex items-baseline justify-between gap-3">
							<span
								class="truncate text-sm"
								:class="msg.flagSeen ? 'text-text-secondary' : 'font-semibold text-text-primary'"
							>
								{{ msg.fromName || msg.fromAddress }}
							</span>
							<span class="text-xs text-text-tertiary flex-shrink-0">
								{{ formatThreadTimestamp(msg.receivedAt) }}
							</span>
						</div>
						<div class="flex items-center gap-1.5 mt-0.5">
							<Icon
								v-if="msg.flagFlagged"
								name="lucide:star"
								class="w-3.5 h-3.5 text-warning"
							/>
							<Icon
								v-if="msg.snoozedUntil"
								name="lucide:clock"
								class="w-3.5 h-3.5 text-brand"
								:title="`Snoozed until ${new Date(msg.snoozedUntil).toLocaleString()}`"
							/>
							<Icon
								v-if="msg.hasAttachments"
								name="lucide:paperclip"
								class="w-3.5 h-3.5 text-text-tertiary"
							/>
							<p
								class="truncate text-sm flex-1"
								:class="msg.flagSeen ? 'text-text-secondary' : 'font-medium text-text-primary'"
							>
								{{ msg.subject || '(no subject)' }}
							</p>
						</div>
						<p class="text-xs text-text-tertiary truncate mt-0.5">{{ msg.snippet }}</p>
					</div>
				</div>
			</component>
			<!-- Hover quick-actions (single-message triage without a round-trip
			     through the bulk selection). -->
			<div
				class="absolute right-3 top-1/2 -translate-y-1/2 hidden group-hover:flex items-center gap-0.5 bg-bg-elevated/95 rounded px-1 py-0.5 shadow-sm border border-border-subtle"
			>
				<button
					type="button"
					class="p-1 rounded hover:bg-bg-surface text-text-tertiary hover:text-warning"
					:title="msg.flagFlagged ? 'Unstar' : 'Star'"
					:aria-label="msg.flagFlagged ? 'Unstar' : 'Star'"
					@click="rowAction($event, () => toggleStar(msg._id, !msg.flagFlagged))"
				>
					<Icon name="lucide:star" class="w-4 h-4" />
				</button>
				<button
					type="button"
					class="p-1 rounded hover:bg-bg-surface text-text-tertiary hover:text-text-primary"
					:title="msg.flagSeen ? 'Mark unread' : 'Mark read'"
					:aria-label="msg.flagSeen ? 'Mark unread' : 'Mark read'"
					@click="rowAction($event, () => toggleRead(msg._id, !msg.flagSeen))"
				>
					<Icon :name="msg.flagSeen ? 'lucide:mail' : 'lucide:mail-open'" class="w-4 h-4" />
				</button>
				<button
					type="button"
					class="p-1 rounded hover:bg-bg-surface text-text-tertiary hover:text-text-primary"
					title="Archive"
					aria-label="Archive"
					@click="rowAction($event, () => archiveMsg(msg._id))"
				>
					<Icon name="lucide:archive" class="w-4 h-4" />
				</button>
				<button
					type="button"
					class="p-1 rounded hover:bg-error/10 text-text-tertiary hover:text-error"
					title="Delete"
					aria-label="Delete"
					@click="rowAction($event, () => trashMsg(msg._id))"
				>
					<Icon name="lucide:trash" class="w-4 h-4" />
				</button>
			</div>
		</li>
	</ul>
	<div v-if="!loading && hasMore" class="p-3 text-center">
		<button
			type="button"
			class="text-sm text-brand hover:underline"
			@click="emit('load-more')"
		>
			Load more
		</button>
	</div>
	<!-- Keyboard-flow pickers for the focused row (h / l / v). -->
	<PostboxSnoozeDialog
		:open="snoozeOpen"
		@update:open="snoozeOpen = $event"
		@confirm="snoozeFocused"
	/>
	<PostboxLabelPickerDialog
		:open="labelOpen"
		:labels="labels"
		@update:open="labelOpen = $event"
		@pick="applyLabelToFocused"
	/>
	<PostboxMovePickerDialog
		:open="moveOpen"
		:folders="movableFolders"
		@update:open="moveOpen = $event"
		@pick="moveFocusedTo"
	/>
</template>
