<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { AnswerModeKind } from '~/utils/answerMode';
import { rememberListPlace, takeListPlace, useAnswerModeNav } from '~/composables/useAnswerMode';
import type { PostboxSwipeAction } from '~/utils/postboxSwipe';
import { POSTBOX_ROW_HEIGHT } from '~/utils/postboxDensity';
import type { PostboxThreadRowMessage } from './PostboxThreadRow.vue';
import { usePostboxThreadListWindow } from '~/composables/postbox/usePostboxThreadListWindow';
import { usePostboxListNow } from '~/composables/postbox/usePostboxListClock';
import { postboxListEmptyState } from '~/utils/postboxListEmptyState';

const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	messages: Array<PostboxThreadRowMessage>;
	loading: boolean;
	folderRole: string;
	/** Set for a custom folder, whose folderRole is empty. Tells folders apart. */
	folderId?: string;
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
	// The scroller this list sits in when it does not scroll in its own box
	// (the Today column stacks it under other sections): windowing and
	// infinite scroll then follow that scroller.
	scrollParent?: HTMLElement | null;
}>();

const emit = defineEmits<{
	(e: 'load-more'): void;
	(e: 'select', messageId: string): void;
	(e: 'clear-filter'): void;
}>();

const { t } = useI18n();
usePostboxListNow(); // one minute clock for every row's timestamp

// Row trust markers (idea 51) ride the badge's flag, resolved once for the list.
const { isEnabled: isFlagEnabled } = useFeatureFlag();
const trustMarkers = computed(() => isFlagEnabled('senderAuthBadges'));

const mailboxIdRef = computed(() => props.mailboxId);
// Which folder the rows belong to. The page stays mounted across folder
// switches, so focus and scroll reset on this key instead of on a remount. It
// is also the folder's route segment (a role, or a custom folder's id: its
// role is empty), so every link into or out of a message is built from it.
const folderKey = computed(() => props.folderId ?? props.folderRole);
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
	moveMany,
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

// r/a/f on a row open Answer mode on that message. No kind for `r`: Answer mode
// resolves the person's default reply mode; it also runs the reply guard, since
// this path never passes through the reader.
const answerNav = useAnswerModeNav();
function openAnswer(id: string, kind: AnswerModeKind | null) {
	void answerNav.open(id, { kind });
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

// Drag a row (or the selection it belongs to) onto a rail folder or label.
const rowDrag = usePostboxListRowDrag({ mailboxId: mailboxIdRef, bulk, moveMany });

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
	resetKey: folderKey,
	rowDomId: (m) => `postbox-row-${m._id}`,
	onActivate: (m) =>
		props.selectable
			? emit('select', m._id)
			: void navigateTo(`/dashboard/postbox/${folderKey.value}/${m._id}`),
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
				openAnswer(m._id, null);
				break;
			case 'replyAll':
				openAnswer(m._id, 'replyAll');
				break;
			case 'forward':
				openAnswer(m._id, 'forward');
				break;
			case 'close':
				// Esc from the list closes the conversation open beside it.
				if (props.activeMessageId && !props.selectable && !props.emptyContext) {
					void navigateTo(`/dashboard/postbox/${folderKey.value}`, { replace: true });
				}
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

// Read-ahead: when the j/k focus or the open message changes, hold the next and
// previous rows' thread and inline-body queries (the ones the reader opens with;
// debounced, LRU-capped and fail-soft) so Enter / auto-advance opens from cache.
const { prefetch: prefetchAdjacent } = usePostboxPrefetch();

// The mouse half of the same read-ahead: hovering (or tabbing to) a row warms
// the thread and body the click is about to need. The composable's 150ms debounce means a
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
const { density, swipeLeftAction, swipeRightAction } = usePostboxSettings();
const {
	scrollEl,
	listEl,
	virtualize,
	range,
	windowStart,
	windowedRows: windowedMessages,
	handleScroll,
} = usePostboxThreadListWindow({
	rows: visibleMessages,
	rowHeight: computed(() => POSTBOX_ROW_HEIGHT[density.value]),
	focusedIndex,
	scrollParent: () => props.scrollParent,
	folderKey: () => folderKey.value,
	activeMessageId: () => props.activeMessageId,
	hasMore: () => props.hasMore === true,
	blocked: () => props.loading || props.loadingMore === true,
	loadMore: () => emit('load-more'),
});

// Back from Answer mode: the j/k row comes back with the list (the scroll offset
// has its own per-folder memory). Filed on every unmount, taken only on the
// mount that is the way back.
onBeforeUnmount(() => {
	rememberListPlace(folderKey.value, {
		focusedId: visibleMessages.value[focusedIndex.value]?._id ?? null,
	});
});
const returnPlace = takeListPlace(folderKey.value);
if (returnPlace?.focusedId) {
	const focusedId = returnPlace.focusedId;
	const stop = watch(
		visibleMessages,
		(rows) => {
			const index = rows.findIndex((m) => m._id === focusedId);
			if (index < 0) return;
			focusedIndex.value = index;
			void nextTick(() => stop());
		},
		{ immediate: true }
	);
}
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
			ref="listEl"
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
					:folder-role="folderKey"
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
					@drag-start="(event: DragEvent) => rowDrag.start(msg, event)"
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
