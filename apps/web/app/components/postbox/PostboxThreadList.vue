<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { PostboxComposeMode, PostboxPendingCompose } from '~/utils/postboxShortcuts';
import { POSTBOX_ROW_HEIGHT } from '~/utils/postboxDensity';
import type { PostboxThreadRowMessage } from './PostboxThreadRow.vue';
import {
	usePostboxVirtualList,
	rememberScroll,
	recallScroll,
} from '~/composables/postbox/usePostboxVirtualList';

const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	messages: Array<PostboxThreadRowMessage>;
	loading: boolean;
	folderRole: string;
	activeMessageId?: string | null;
	hasMore?: boolean;
	// When set, clicking a row (or pressing Enter) emits `select` for in-place
	// preview instead of navigating to the folder/message route. Used by the
	// search results screen, which previews hits in its own right-hand pane
	// rather than ejecting the user into the three-pane folder view.
	selectable?: boolean;
	// Overrides the folder-role-derived empty state (e.g. the label view
	// renders with folder-role "inbox" for row links but must not claim
	// "All clear" when the label simply has no messages).
	emptyContext?: 'label';
}>();

const emit = defineEmits<{
	(e: 'load-more'): void;
	(e: 'select', messageId: string): void;
}>();

const mailboxIdRef = computed(() => props.mailboxId);
const bulk = usePostboxBulkActions(mailboxIdRef);

const mid = (id: string) => id as unknown as Id<'mailMessages'>;

const archiveOp = useBackendOperation(api.mail.messageActions.archive, { label: 'Archive' });
const trashOp = useBackendOperation(api.mail.messageActions.trash, { label: 'Move to trash' });
const setStarOp = useBackendOperation(api.mail.messageActions.setStar, { label: 'Star' });
const markReadOp = useBackendOperation(api.mail.messageActions.markRead, { label: 'Mark read' });

// Optimistic row removal — hide on archive/trash, restore on failure (see
// usePostboxOptimisticHide).
const messagesRef = computed(() => props.messages);
const {
	visible: visibleMessages,
	hide: hideRow,
	unhide: unhideRow,
} = usePostboxOptimisticHide(messagesRef);

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

// Pending compose intent for r/a/f from the list: opening the composer needs the
// reader's quoting/recipient logic, so we open the message first and let
// PostboxThreadReader consume the intent once it renders.
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

// Follow-up chip on a watched row: cancel the armed watch / dismiss the due
// "No reply yet" indicator. Ownership-checked server-side.
const cancelFollowUpOp = useBackendOperation(api.mail.followUps.cancel, {
	label: 'Cancel reply reminder',
});
function cancelFollowUp(msg: { threadId?: string }) {
	if (!msg.threadId) return;
	void cancelFollowUpOp.run({ threadId: msg.threadId as Id<'mailThreads'> });
}

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

// Context-aware empty state: inbox-zero gets a quiet "All clear" moment;
// empty custom folders (no role) and label views get a one-line hint with a
// relevant action; other system folders keep a neutral "No messages".
const emptyState = computed(() => {
	if (props.emptyContext === 'label') {
		return {
			icon: 'lucide:tag',
			title: 'No messages with this label',
			hint: 'Apply it from a message with the label shortcut (l).',
			showFilterAction: false,
		};
	}
	if (props.folderRole === 'inbox') {
		return {
			icon: 'lucide:check-circle-2',
			title: 'All clear',
			hint: undefined,
			showFilterAction: false,
		};
	}
	if (props.folderRole === '') {
		return {
			icon: 'lucide:folder-open',
			title: 'This folder is empty',
			hint: 'Move messages here, or route them automatically with a filter.',
			showFilterAction: true,
		};
	}
	return { icon: 'lucide:inbox', title: 'No messages', hint: undefined, showFilterAction: false };
});

// Keyboard triage (Gmail/Superhuman-style): j/k move, Enter opens; single-key
// actions resolve via utils/postboxShortcuts.ts (e archive, # delete, s star,
// u toggle read, Shift+U unread, x select, r/a/f compose, h/l/v pickers).
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

// Read-ahead: when the j/k focus or the open message changes, warm the next and
// previous rows' bodies (same query the reader runs, debounced, LRU-capped and
// fail-soft) so Enter / auto-advance opens instantly, not on a body round-trip.
const { prefetch: prefetchAdjacent } = usePostboxPrefetch();
watch([focusedIndex, () => props.activeMessageId], () => {
	const ids = visibleIds.value;
	let anchor = focusedIndex.value;
	if (anchor < 0 && props.activeMessageId) anchor = ids.indexOf(props.activeMessageId);
	if (anchor < 0) return;
	prefetchAdjacent([ids[anchor + 1], ids[anchor - 1]]);
});

// --- Windowed rendering + infinite scroll (large folders) --------------------
// Only large folders pay the windowing cost; small folders keep the simple
// content-visibility path unchanged (and group/category modes use their own
// non-virtual list components entirely). Row height is a known per-density
// constant, so this is fixed-height windowing with no dynamic measurement.
const VIRTUAL_THRESHOLD = 100;
const scrollEl = ref<HTMLElement | null>(null);
const { density } = usePostboxSettings();
const rowHeight = computed(() => POSTBOX_ROW_HEIGHT[density.value]);
const itemCount = computed(() => visibleMessages.value.length);
const virtualize = computed(() => itemCount.value > VIRTUAL_THRESHOLD);

const { range, syncScroll, scrollToIndex } = usePostboxVirtualList({
	scrollEl,
	itemCount,
	rowHeight,
	enabled: virtualize,
});

// Rows actually mounted: a bounded window when virtualizing, everything
// otherwise. `windowStart` maps a windowed row back to its absolute index so
// focus, selection and ARIA stay correct.
const windowStart = computed(() => (virtualize.value ? range.value.startIndex : 0));
const windowedMessages = computed(() =>
	virtualize.value
		? visibleMessages.value.slice(range.value.startIndex, range.value.endIndex)
		: visibleMessages.value
);

// Keep the keyboard-focused row visible even when it is outside the mounted
// window: shift the scroll (which re-derives the window and mounts the row);
// usePostboxListKeyboard's own scrollIntoView then refines to "nearest".
watch(focusedIndex, (idx) => {
	if (idx < 0 || !virtualize.value) return;
	scrollToIndex(idx);
});

// Auto-grow the page as the window nears the end (replacing the manual "Load
// more" click; the button stays as an always-available fallback). Guarded to
// one emit per page count so a load in flight is never spammed — the count
// changes when the new page lands, which re-arms the trigger.
const AUTOLOAD_MARGIN_PX = 240;
let emittedForCount = -1;
const folderScrollKey = computed(() => `postbox:scroll:${props.folderRole}`);

function onListScroll(event: Event) {
	const el = event.target as HTMLElement;
	syncScroll();
	rememberScroll(folderScrollKey.value, el.scrollTop);
	if (
		props.hasMore &&
		!props.loading &&
		emittedForCount !== itemCount.value &&
		el.scrollHeight - el.scrollTop - el.clientHeight < AUTOLOAD_MARGIN_PX
	) {
		emittedForCount = itemCount.value;
		emit('load-more');
	}
}

// Restore the folder's last scroll position when the list (re)mounts, e.g.
// returning from an opened thread. Best-effort: if the rows aren't tall enough
// yet the browser clamps the value.
onMounted(async () => {
	await nextTick();
	const saved = recallScroll(folderScrollKey.value);
	if (saved != null && scrollEl.value) {
		scrollEl.value.scrollTop = saved;
		syncScroll();
	}
});
</script>

<template>
	<!-- Scroll container owns the folder's scroll position (windowing +
	     infinite-scroll + restore all key off it). -->
	<div ref="scrollEl" class="h-full overflow-auto scroll-fade" @scroll="onListScroll">
		<!-- Skeleton only on FIRST load (no rows yet): live-query refreshes keep
	     `keepPreviousData` rows visible, so they never flash the skeleton. -->
		<PostboxThreadListSkeleton v-if="loading && visibleMessages.length === 0" />
		<PostboxEmptyState
			v-else-if="visibleMessages.length === 0"
			:icon="emptyState.icon"
			:title="emptyState.title"
			:hint="emptyState.hint"
		>
			<template v-if="emptyState.showFilterAction" #action>
				<NuxtLink
					to="/dashboard/postbox/settings/filters"
					class="inline-block mt-2 text-xs text-brand hover:underline"
				>
					Set up a filter
				</NuxtLink>
			</template>
		</PostboxEmptyState>
		<!-- role=listbox owns the full scroll height (so the scrollbar reflects all
	     rows even while only a window is mounted); the inner container is
	     translate-positioned to the window's offset. Small folders render every
	     row with no offset. -->
		<ul
			v-else
			tabindex="0"
			role="listbox"
			aria-label="Messages"
			:aria-activedescendant="activeRowId"
			class="outline-none focus-visible:ring-1 focus-visible:ring-brand/40 focus-visible:ring-inset"
			:class="{ relative: virtualize }"
			:style="virtualize ? { height: `${range.totalHeight}px` } : undefined"
			@keydown="onListKeydown"
		>
			<div
				class="divide-y divide-border-subtle"
				:class="{ 'absolute inset-x-0 top-0': virtualize }"
				:style="virtualize ? { transform: `translateY(${range.offsetY}px)` } : undefined"
			>
				<PostboxThreadRow
					v-for="(msg, localI) in windowedMessages"
					:key="msg._id"
					:msg="msg"
					:selectable="selectable"
					:folder-role="props.folderRole"
					:virtualize="virtualize"
					:selected="bulk.isSelected(msg._id as unknown as Id<'mailMessages'>)"
					:focused="focusedIndex === windowStart + localI"
					:active="activeMessageId === msg._id"
					@select="emit('select', msg._id)"
					@toggle-select="bulk.toggle(mid(msg._id))"
					@toggle-star="toggleStar(msg._id, !msg.flagFlagged)"
					@toggle-read="toggleRead(msg._id, !msg.flagSeen)"
					@archive="archiveMsg(msg._id)"
					@trash="trashMsg(msg._id)"
					@cancel-follow-up="cancelFollowUp(msg)"
				/>
			</div>
		</ul>
		<!-- Fallback trigger: infinite scroll auto-grows the page, but the button
	     stays so a user can still advance if the auto-load stalls or errors. -->
		<div v-if="!loading && hasMore" class="p-3 text-center">
			<button type="button" class="text-sm text-brand hover:underline" @click="emit('load-more')">
				Load more
			</button>
		</div>
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
