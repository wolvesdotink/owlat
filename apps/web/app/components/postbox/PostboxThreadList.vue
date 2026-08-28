<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { PostboxComposeMode, PostboxPendingCompose } from '~/utils/postboxShortcuts';
import type { PostboxSwipeAction } from '~/utils/postboxSwipe';
import { POSTBOX_ROW_HEIGHT } from '~/utils/postboxDensity';
import type { PostboxThreadRowMessage } from './PostboxThreadRow.vue';
import {
	usePostboxVirtualList,
	rememberScroll,
	recallScroll,
} from '~/composables/postbox/usePostboxVirtualList';
import { usePostboxListAutoLoad } from '~/composables/postbox/usePostboxListAutoLoad';
import { postboxListEmptyState } from '~/utils/postboxListEmptyState';

const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	messages: Array<PostboxThreadRowMessage>;
	loading: boolean;
	folderRole: string;
	activeMessageId?: string | null;
	/** A further page exists AND there is a cursor to walk to it. */
	hasMore?: boolean;
	/** A "Load more" page is in flight (distinct from the first-load skeleton). */
	loadingMore?: boolean;
	// True when more rows exist but the view has no cursor to reach them (the
	// take()-bounded Snoozed folder). Renders an honest cap note instead of a
	// Load more that cannot advance.
	capped?: boolean;
	// When set, clicking a row (or pressing Enter) emits `select` for in-place
	// preview instead of navigating to the folder/message route. Used by the
	// search results screen, which previews hits in its own right-hand pane
	// rather than ejecting the user into the three-pane folder view.
	selectable?: boolean;
	// Overrides the folder-role-derived empty state (e.g. the label view
	// renders with folder-role "inbox" for row links but must not claim
	// "All clear" when the label simply has no messages).
	emptyContext?: 'label';
	// True when a triage filter chip (Unread/Starred/Attachments) is hiding
	// rows that exist — the empty state then offers "Show all" instead of the
	// folder's usual copy, so a filtered-to-zero list never reads as
	// "nothing here".
	filterActive?: boolean;
}>();

const emit = defineEmits<{
	(e: 'load-more'): void;
	(e: 'select', messageId: string): void;
	(e: 'clear-filter'): void;
}>();

const { t } = useI18n();

// Row trust markers (idea 51) ride the badge's flag, resolved once for the list.
const { isEnabled: isFlagEnabled } = useFeatureFlag();
const trustMarkers = computed(() => isFlagEnabled('senderAuthBadges'));

const mailboxIdRef = computed(() => props.mailboxId);
const bulk = usePostboxBulkActions(mailboxIdRef);

// Optimistic row state, in two layers over the rows the folder query delivers:
//   - flags: star / mark-read paint immediately and are pruned once the live
//     row agrees (usePostboxOptimisticFlags), then
//   - removal: archive/trash/snooze hide the row, restoring it on failure
//     (usePostboxOptimisticHide).
const messagesRef = computed(() => props.messages);
const {
	rows: flaggedMessages,
	setFlags: setRowFlags,
	clearFlags: clearRowFlags,
} = usePostboxOptimisticFlags(messagesRef);
const {
	visible: visibleMessages,
	hide: hideRow,
	unhide: unhideRow,
} = usePostboxOptimisticHide(flaggedMessages);

// Visual row order for the reader's auto-advance (PostboxLayout reads this
// via a template ref): the optimistic-hide-filtered list as rendered.
const visibleIds = computed(() => visibleMessages.value.map((m) => m._id));
defineExpose({ visibleIds });

// The triage verbs themselves (one action source for the hover buttons, the
// context menu, the long-press menu and the single-key shortcuts), including
// the optimistic hide/restore and the "Undo — Cmd+Z" registration.
const {
	archiveMsg,
	trashMsg,
	moveMsg,
	snoozeMsg,
	snoozeThread,
	toggleMute,
	toggleStar,
	toggleRead,
	cancelFollowUp,
} = usePostboxRowTriage({
	hide: hideRow,
	unhide: unhideRow,
	setFlags: setRowFlags,
	clearFlags: clearRowFlags,
});

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

// h/l/v open a picker for the focused row; the target id is captured on open so
// a focus change while the dialog is up can't retarget the action.
const {
	snoozeOpen,
	labelOpen,
	moveOpen,
	labels,
	movableFolders,
	openSnooze,
	openLabel,
	openMove,
	snoozeFocused,
	applyLabelToFocused,
	moveFocusedTo,
} = usePostboxRowPickers({
	mailboxId: mailboxIdRef,
	folderRole: computed(() => props.folderRole),
	snoozeMsg,
	snoozeThread,
	moveMsg,
});

/**
 * A committed swipe on a row (UX plan idea 21). It is a fourth ENTRY POINT, not
 * a fourth implementation: every branch lands on the verb the hover buttons,
 * the context menu and the single-key shortcuts already call, so the optimistic
 * hide and the "Undo — Cmd+Z" registration come along for free. Snooze opens
 * the same picker `h` does — a deferral needs a time, and guessing one from a
 * gesture is how mail disappears until Thursday.
 */
function onRowSwipe(m: PostboxThreadRowMessage, action: Exclude<PostboxSwipeAction, 'none'>) {
	switch (action) {
		case 'archive':
			void archiveMsg(m._id);
			break;
		case 'trash':
			void trashMsg(m._id);
			break;
		case 'star':
			void toggleStar(m._id, !m.flagFlagged);
			break;
		case 'read':
			void toggleRead(m._id, !m.flagSeen);
			break;
		case 'snooze':
			openSnooze(m._id, m.threadId ?? null);
			break;
	}
}

/** Mute/unmute the focused row's conversation (the `m` shortcut + context menu). */
function toggleMuteRow(m: PostboxThreadRowMessage) {
	void toggleMute(m._id, m.mutedAt == null);
}

// Context-aware empty state — a filtered-to-zero folder, inbox zero, an empty
// label and an empty custom folder each say something different. The choice is
// a pure derivation (utils/postboxListEmptyState.ts); this is the render
// boundary that resolves its catalog keys.
const emptyState = computed(() => {
	const state = postboxListEmptyState({
		filterActive: props.filterActive === true,
		hasMore: props.hasMore === true,
		emptyContext: props.emptyContext,
		folderRole: props.folderRole,
	});
	return {
		icon: state.icon,
		title: t(state.titleKey),
		hint: state.hintKey ? t(state.hintKey) : undefined,
		showFilterAction: state.showFilterAction,
	};
});

// Keyboard triage (Gmail/Superhuman-style): j/k move, Enter opens; single-key
// actions resolve through the one shortcut registry via
// utils/postboxShortcuts.ts (e archive, # delete, s star, u toggle read,
// Shift+U unread, x select, n/p unread jumps, z undo, r/a/f compose, h/l/v
// pickers) — so the user's preset and remaps apply here without this component
// knowing which key is which.
const triageUndo = usePostboxTriageUndo();

/**
 * `n` / `p`: move the focus to the nearest unread row in that direction. The
 * search itself is pure (`nextUnreadIndex`); this only translates it to focus.
 */
function jumpToUnread(direction: 1 | -1) {
	const target = nextUnreadIndex(
		visibleMessages.value.map((m) => m.flagSeen === true),
		focusedIndex.value,
		direction
	);
	if (target >= 0) focusedIndex.value = target;
}

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
	// Shift+J / Shift+K drag the selection along with the focus, extending from
	// the anchor the last plain toggle set.
	onExtendSelection: (to, from) => bulk.extendTo(visibleIds.value, to._id, from?._id),
	onAction: (key, m) => {
		switch (resolvePostboxShortcut(key)) {
			case 'archive':
				void archiveMsg(m._id);
				break;
			case 'trash':
				void trashMsg(m._id);
				break;
			case 'star':
				void toggleStar(m._id, !m.flagFlagged);
				break;
			case 'toggleRead':
				void toggleRead(m._id, !m.flagSeen);
				break;
			case 'markUnread':
				void toggleRead(m._id, false);
				break;
			case 'toggleSelect':
				bulk.toggle(m._id);
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
				openSnooze(m._id, m.threadId ?? null);
				break;
			case 'mute':
				toggleMuteRow(m);
				break;
			case 'label':
				openLabel(m._id);
				break;
			case 'move':
				openMove(m._id);
				break;
			case 'nextUnread':
				jumpToUnread(1);
				break;
			case 'previousUnread':
				jumpToUnread(-1);
				break;
			case 'undo':
				// The bare `z` of the Gmail vocabulary, alongside the app-wide
				// Cmd/Ctrl+Z that usePostboxTriageUndo binds for itself. No-op with
				// an empty stack, so it never eats the key for nothing.
				void triageUndo.undo();
				break;
			// 'help' is handled by the window-level PostboxShortcutHelp listener.
		}
	},
});

// Read-ahead: when the j/k focus or the open message changes, warm the next and
// previous rows' bodies (same query the reader runs, debounced, LRU-capped and
// fail-soft) so Enter / auto-advance opens instantly, not on a body round-trip.
const { prefetch: prefetchAdjacent } = usePostboxPrefetch();

// The mouse half of the same read-ahead: hovering (or tabbing to) a row warms
// the body the click is about to need. The composable's 150ms debounce means a
// pointer sweeping down the list warms only where it comes to rest, and its LRU
// cap bounds what a long sweep can accumulate — so this needs no throttle of
// its own.
function prefetchRow(id: string) {
	prefetchAdjacent([id]);
}
watch([focusedIndex, () => props.activeMessageId], () => {
	const ids = visibleIds.value;
	let anchor = focusedIndex.value;
	if (anchor < 0 && props.activeMessageId)
		anchor = ids.findIndex((id) => id === props.activeMessageId);
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
const { density, swipeLeftAction, swipeRightAction } = usePostboxSettings();
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
// more" click; the button stays as an always-available fallback), coalesced to
// one derivation per animation frame.
const folderScrollKey = computed(() => `postbox:scroll:${props.folderRole}`);
const { handleScroll } = usePostboxListAutoLoad({
	scrollEl,
	itemCount,
	hasMore: computed(() => props.hasMore === true),
	blocked: computed(() => props.loading || props.loadingMore === true),
	onScroll: (el) => {
		syncScroll();
		rememberScroll(folderScrollKey.value, el.scrollTop);
	},
	loadMore: () => emit('load-more'),
});

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
	     infinite-scroll + restore all key off it). `.postbox-thread-list`
	     scopes the touch-device CSS (postbox-density.css) to this list only. -->
	<div
		ref="scrollEl"
		class="postbox-thread-list h-full overflow-auto scroll-fade"
		@scroll="handleScroll()"
	>
		<!-- Skeleton only on FIRST load (no rows yet): live-query refreshes keep
	     `keepPreviousData` rows visible, so they never flash the skeleton. -->
		<PostboxThreadListSkeleton v-if="loading && visibleMessages.length === 0" />
		<PostboxEmptyState
			v-else-if="visibleMessages.length === 0"
			:icon="emptyState.icon"
			:title="emptyState.title"
			:hint="emptyState.hint"
		>
			<template v-if="filterActive" #action>
				<button
					type="button"
					class="inline-block mt-2 text-xs text-brand hover:underline"
					@click="emit('clear-filter')"
				>
					{{ t('components.postbox.postboxThreadList.showAllMessages') }}
				</button>
			</template>
			<template v-else-if="emptyState.showFilterAction" #action>
				<NuxtLink
					to="/dashboard/preferences/filters"
					class="inline-block mt-2 text-xs text-brand hover:underline"
				>
					{{ t('components.postbox.postboxThreadList.setUpFilter') }}
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
			:aria-label="t('components.postbox.postboxThreadList.listLabel')"
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
					:trust-markers="trustMarkers"
					:swipe-left="swipeLeftAction"
					:swipe-right="swipeRightAction"
					:folder-role="props.folderRole"
					:virtualize="virtualize"
					:selected="bulk.isSelected(msg._id)"
					:focused="focusedIndex === windowStart + localI"
					:active="activeMessageId === msg._id"
					@select="emit('select', msg._id)"
					@toggle-select="
						(extend: boolean) =>
							extend ? bulk.extendTo(visibleIds, msg._id) : bulk.toggle(msg._id)
					"
					@toggle-star="toggleStar(msg._id, !msg.flagFlagged)"
					@toggle-read="toggleRead(msg._id, !msg.flagSeen)"
					@archive="archiveMsg(msg._id)"
					@trash="trashMsg(msg._id)"
					@toggle-mute="toggleMuteRow(msg)"
					@prefetch="prefetchRow(msg._id)"
					@cancel-follow-up="cancelFollowUp(msg)"
					@swipe="(action: Exclude<PostboxSwipeAction, 'none'>) => onRowSwipe(msg, action)"
				/>
			</div>
		</ul>
		<!-- Fallback trigger: infinite scroll auto-grows the page, but the button
	     stays so a user can still advance if the auto-load stalls or errors. -->
		<div v-if="loadingMore" class="p-3 text-center text-sm text-text-tertiary" role="status">
			{{ t('components.postbox.postboxThreadList.loadingMore') }}
		</div>
		<div v-else-if="!loading && hasMore" class="p-3 text-center">
			<button type="button" class="text-sm text-brand hover:underline" @click="emit('load-more')">
				{{ t('components.postbox.postboxThreadList.loadMore') }}
			</button>
		</div>
		<p
			v-else-if="capped && visibleMessages.length > 0"
			class="px-4 py-3 text-center text-xs text-text-tertiary"
			role="status"
		>
			{{ t('components.postbox.postboxThreadList.capNote') }}
		</p>
	</div>
	<!-- Keyboard-flow pickers for the focused row (h / l / v). -->
	<PostboxSnoozeDialog
		:open="snoozeOpen"
		scoped
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
