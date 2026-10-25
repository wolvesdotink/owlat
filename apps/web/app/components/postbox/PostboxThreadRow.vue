<script lang="ts">
import { NuxtLink } from '#components';
import type { Doc, Id } from '@owlat/api/dataModel';
import type { ListUnsubscribeTarget } from '@owlat/shared/listUnsubscribe';
import type { SenderAuthMessage } from '~/utils/senderAuth';
import type { BriefTopRow } from '../../../../api/convex/mail/interpret/briefTop';
import type { Placement } from '@owlat/shared/arrival';

/**
 * One thread-list row's message shape. Extracted here (shared with
 * PostboxThreadList.vue) so the list and the row agree on the projection the
 * folder query returns.
 *
 * It extends `SenderAuthMessage` — the persisted SPF/DKIM/DMARC verdicts, the
 * domains those checks authenticated and the ingest impersonation heuristics —
 * because the row now derives the danger-only trust marker (UX plan idea 51)
 * from exactly the fields the reader's badge reads. `mail/mailbox/queries.ts`
 * already returns whole `mailMessages` documents, so nothing new crosses the
 * wire; every field is optional, so a legacy row simply yields no marker.
 */
export type PostboxThreadRowMessage = SenderAuthMessage & {
	_id: Id<'mailMessages'>;
	mailboxId?: string;
	threadId?: string;
	fromAddress: string;
	fromName?: string;
	subject: string;
	snippet: string;
	receivedAt: number;
	flagSeen: boolean;
	flagFlagged: boolean;
	hasAttachments: boolean;
	snoozedUntil?: number;
	// Thread follow-up watch state (mail/followUps.ts): `watched` marks the
	// sent message the watch points at; `dueAt` means the deadline passed
	// with no reply ("No reply yet" chip).
	followUp?: { remindAt: number; dueAt?: number; watched: boolean };
	// The row's thread is MUTED (mail/mute.ts) — new mail on it skips the
	// inbox and never notifies. Present so the silence is legible.
	mutedAt?: number;
	// The row's thread is in the Inbox's pinned band (mail/pins.ts).
	pinnedAt?: number;
	// The row's thread just came BACK from snooze (mail/snooze.ts sweep).
	// Transient: the reader clears it the first time the thread is opened.
	snoozeReturnedAt?: number;
	// The thread's advisory smart-inbox category (mail/category.ts), attached
	// server-side so the Today and Bundled views group every page alike.
	category?: NonNullable<Doc<'mailThreads'>['category']>['label'];
	// Parsed List-Unsubscribe target; `oneClick` is what lets a bundle offer one.
	unsubscribe?: ListUnsubscribeTarget;
	// The thread brief's top open item (mail/interpret/briefTop.ts), shown
	// instead of the snippet once the thread is interpreted.
	briefTop?: BriefTopRow;
	// The thread's Priority placement (read on arrival §3), attached server-side.
	placement?: Placement;
};
</script>

<script setup lang="ts">
/**
 * A single Postbox thread-list row. The list owns the v-for, windowing and all
 * mutations; this component is a pure presentational row that maps DOM events to
 * semantic emits (its `<li>` is the v-for element root). Splitting the row out
 * keeps PostboxThreadList.vue under the file-size ratchet.
 *
 * What the row SAYS (sender, trust marker, chips, subject, snippet) lives in
 * PostboxThreadRowBody, shared with the section and bundle renderers; this
 * shell adds what only the flat list wires: selection, avatar, hover triage,
 * the context menu and swipe.
 */
import type { ContextMenuItem } from '@owlat/ui/components/ui/ContextMenu.vue';
import type { PostboxSwipeAction } from '~/utils/postboxSwipe';
import { createPostboxSweepHandle, type PostboxSweepMark } from '~/utils/postboxSweep';
import { usePostboxRowGestures } from '~/composables/postbox/usePostboxRowGestures';
import { usePostboxMessageDrag } from '~/composables/postbox/usePostboxMessageDrag';
import { senderRowMarkerOf } from '~/utils/senderAuth';
import { usePostboxListQuery } from '~/composables/postbox/usePostboxPlacementFilter';
import { inject } from 'vue';
import { usePostboxWhyHere } from '~/composables/postbox/usePostboxWhyHere';
import { POSTBOX_PRIORITY_ROWS } from '~/utils/postboxPriorityGroups';
import { vReplyDrop } from '~/composables/useReplyFileDrop';
import { replyDropForMessage } from '~/utils/replyFileDrop';

const { t } = useI18n();
// A filtered list (`?placement=`) keeps its filter on the message route.
const listQuery = usePostboxListQuery();

const props = defineProps<{
	msg: PostboxThreadRowMessage;
	selectable?: boolean;
	/** The folder's route segment: its role, or a custom folder's id. */
	folderRole: string;
	virtualize: boolean;
	selected: boolean;
	focused: boolean;
	active: boolean;
	/**
	 * Flag gate for the danger-only sender-trust marker (`senderAuthBadges`).
	 * Resolved once by the list rather than per row, so a folder page does not
	 * mount one flag subscription per visible row.
	 */
	trustMarkers?: boolean;
	/**
	 * The swipe mapping (UX plan idea 21), resolved once by the list rather than
	 * per row so a folder page does not mount one settings subscription per
	 * visible row. Absent on either side means that direction is inert.
	 */
	swipeLeft?: PostboxSwipeAction;
	swipeRight?: PostboxSwipeAction;
	/** What a sweep in progress will do to this row on release; null when none covers it. */
	sweepMark?: PostboxSweepMark | null;
}>();

const emit = defineEmits<{
	select: [];
	/** True when the pointer/key carried Shift: extend the range from the anchor. */
	'toggle-select': [extend: boolean];
	'toggle-star': [];
	'toggle-read': [];
	archive: [];
	trash: [];
	'toggle-mute': [];
	'toggle-pin': [];
	'cancel-follow-up': [];
	/** A committed swipe (idea 21). The list maps it onto its own triage verbs. */
	swipe: [action: Exclude<PostboxSwipeAction, 'none'>];
	/**
	 * The pointer or the focus ring landed on this row — the list warms its body
	 * (debounced, so a sweep across the list costs one round-trip, not one per
	 * row it passes over).
	 */
	prefetch: [];
	/**
	 * A mouse drag picked the row up. The list decides what it carries (this
	 * row, or the whole selection) and the rail's folders are the targets.
	 */
	'drag-start': [event: DragEvent];
	/** A press on the checkbox or the Archive button: the list may turn it into a sweep. */
	'sweep-start': [kind: 'select' | 'archive', event: PointerEvent];
}>();

const rowId = computed(() => `postbox-row-${props.msg._id}`);

// Dimmed while it travels; the drag in flight is shared module state.
const messageDrag = usePostboxMessageDrag();

// Files dropped on the row reply to its message, in Answer mode.
const replyDrop = computed(() => replyDropForMessage(props.msg, props.folderRole));

/** The row accent for a danger-only sender marker; the body renders the chip. */
const isDanger = computed(() => senderRowMarkerOf(props.msg, props.trustMarkers) !== null);

/** The checkbox as it will read once the sweep covering this row is released. */
const shownSelected = computed(() =>
	props.sweepMark === 'select' ? true : props.sweepMark === 'deselect' ? false : props.selected
);

// A press on the checkbox or the Archive button may start a sweep (utils/postboxSweep.ts).
const sweepHandle = createPostboxSweepHandle((kind, event) => emit('sweep-start', kind, event));
function onRowPointerdown(event: PointerEvent) {
	sweepHandle.onPointerdown(event);
	gestures.onPointerdown(event);
}
function onDragstart(event: DragEvent) {
	if (!sweepHandle.claimsDrag(event)) emit('drag-start', event);
}

/**
 * Checkbox toggles selection without following the row's NuxtLink. Shift means
 * "extend from the anchor" — the file-manager idiom, so twenty messages take
 * two clicks rather than twenty.
 */
function onCheckboxClick(event: MouseEvent) {
	event.stopPropagation();
	event.preventDefault();
	emit('toggle-select', event.shiftKey);
}

/**
 * Emit one of the row's triage verbs. Both the hover-action buttons and the
 * right-click context menu route through here, so there is ONE action source
 * (the list's mutation handlers) with two entry points.
 *
 * Narrow to a literal per branch: Vue types `emit` as an intersection of
 * per-event call signatures, so a union-typed argument matches no overload.
 */
function triage(
	e: 'toggle-star' | 'toggle-read' | 'archive' | 'trash' | 'toggle-mute' | 'toggle-pin'
) {
	switch (e) {
		case 'toggle-star':
			emit('toggle-star');
			break;
		case 'toggle-read':
			emit('toggle-read');
			break;
		case 'archive':
			emit('archive');
			break;
		case 'trash':
			emit('trash');
			break;
		case 'toggle-mute':
			emit('toggle-mute');
			break;
		case 'toggle-pin':
			emit('toggle-pin');
			break;
	}
}

/** Stop a hover-action button from following the row's NuxtLink, then triage. */
function rowAction(event: MouseEvent, e: 'toggle-star' | 'toggle-read' | 'archive' | 'trash') {
	event.stopPropagation();
	event.preventDefault();
	triage(e);
}

// Read on arrival §4.1: a Priority row explains its placement from the hover bar.
const whyHere = usePostboxWhyHere();
const isPriorityRow = inject(POSTBOX_PRIORITY_ROWS, false);
const isWhyHereShown = computed(
	() => isPriorityRow && !!props.msg.placement && !!props.msg.threadId
);
function openWhyHere(event: MouseEvent) {
	event.stopPropagation();
	event.preventDefault();
	const { mailboxId, threadId, placement } = props.msg;
	if (!mailboxId || !threadId) return;
	whyHere.open({
		mailboxId,
		threadId,
		...(placement ? { placement } : {}),
		anchor: event.currentTarget as HTMLElement,
	});
}

// Right-click / context-menu-key items — the same triage verbs as the hover
// row-actions (one action source, two entry points).
const contextItems = computed<ContextMenuItem[]>(() => [
	{
		id: 'star',
		label: props.msg.flagFlagged
			? t('components.postbox.postboxThreadRow.unstar')
			: t('components.postbox.postboxThreadRow.star'),
		icon: 'lucide:star',
		run: () => triage('toggle-star'),
	},
	{
		id: 'read',
		label: props.msg.flagSeen
			? t('components.postbox.postboxThreadRow.markAsUnread')
			: t('components.postbox.postboxThreadRow.markAsRead'),
		icon: props.msg.flagSeen ? 'lucide:mail' : 'lucide:mail-open',
		run: () => triage('toggle-read'),
	},
	{
		id: 'archive',
		label: t('common.archive'),
		icon: 'lucide:archive',
		run: () => triage('archive'),
	},
	{
		id: 'pin',
		label: props.msg.pinnedAt
			? t('components.postbox.postboxThreadRow.unpin')
			: t('components.postbox.postboxThreadRow.pin'),
		icon: props.msg.pinnedAt ? 'lucide:pin-off' : 'lucide:pin',
		run: () => triage('toggle-pin'),
	},
	{
		id: 'mute',
		label: props.msg.mutedAt
			? t('components.postbox.postboxThreadRow.unmute')
			: t('components.postbox.postboxThreadRow.mute'),
		icon: props.msg.mutedAt ? 'lucide:bell' : 'lucide:bell-off',
		run: () => triage('toggle-mute'),
	},
	{
		id: 'trash',
		label: t('common.delete'),
		icon: 'lucide:trash',
		danger: true,
		separatorBefore: true,
		run: () => triage('trash'),
	},
]);

// ── Touch entry points: long-press for the menu, swipe to triage ──
// On touch devices the hover-reveal actions stay visible at rest
// (postbox-density.css), but the triage verbs' other entry points — the
// right-click menu and a pointer that can hover — never fire. A ~500ms hold
// re-dispatches the row's own `contextmenu` event at the touch point, so
// UiContextMenu's existing open-at-position path (focus trap, Esc handling,
// one action source) runs unchanged; a horizontal drag past the commit
// distance emits `swipe`, which the list routes into the SAME verbs (UX plan
// idea 21). Both live in one composable because they are one pointer stream:
// the first few pixels of movement decide which gesture it becomes.
const gestures = usePostboxRowGestures({
	leftAction: () => props.swipeLeft ?? 'none',
	rightAction: () => props.swipeRight ?? 'none',
	onSwipe: (action) => emit('swipe', action),
	onLongPress: (row, point) =>
		row.dispatchEvent(
			new MouseEvent('contextmenu', {
				bubbles: true,
				cancelable: true,
				clientX: point.x,
				clientY: point.y,
			})
		),
});

/** Swallow the click a fired long-press or a swipe leaves behind. */
function onCapturedClick(event: MouseEvent) {
	// Shift+click anywhere on the row extends the selection instead of opening
	// the message — a range that only the 4x4px checkbox could start would be
	// the idiom in name only.
	if (event.shiftKey) {
		event.preventDefault();
		event.stopPropagation();
		emit('toggle-select', true);
		return;
	}
	if (!gestures.consumeClickSuppression()) return;
	event.preventDefault();
	event.stopPropagation();
}
</script>

<template>
	<UiContextMenu :items="contextItems">
		<template #default="{ onContextmenu, onKeydown }">
			<!-- `role="none"` because the OPTION is the link below, not this `<li>`.
			     Left implicit, the `<li>` announced as a `listitem` the surrounding
			     `role="listbox"` may not own (axe: aria-required-children), the link
			     announced as an `option` with no listbox parent
			     (aria-required-parent), and the `<li>` as a list item with no list
			     (listitem) — three critical/serious violations for one missing
			     attribute. The `<li role="none"><a role="option">` shape is the same
			     one the menu pattern uses, and the presentational hop is what lets
			     the listbox own the link. -->
			<li
				v-reply-drop="replyDrop"
				role="none"
				class="group relative pbx-row-li"
				:class="{
					'pbx-virtual-row': virtualize,
					'pbx-row-danger': isDanger,
					'pbx-row-swiping': !!gestures.track.value,
					'opacity-50': messageDrag.isDragged(msg._id),
				}"
				:data-sweep-row="msg._id"
				:data-sweep-mark="sweepMark ?? undefined"
				draggable="true"
				style="
					content-visibility: auto;
					contain-intrinsic-size: auto var(--pbx-row-intrinsic, 76px);
				"
				@contextmenu="onContextmenu"
				@keydown="onKeydown"
				@mouseenter="emit('prefetch')"
				@focusin="emit('prefetch')"
				@pointerdown="onRowPointerdown"
				@pointermove="gestures.onPointermove"
				@pointerup="gestures.onPointerup"
				@pointercancel="gestures.onPointercancel"
				@click.capture="onCapturedClick"
				@dragstart="onDragstart"
				@dragend="messageDrag.end()"
			>
				<!-- Revealed behind the row while it follows the finger sideways. -->
				<PostboxSwipeTrack v-if="gestures.track.value" :track="gestures.track.value" />
				<component
					:is="selectable ? 'div' : NuxtLink"
					:id="rowId"
					role="option"
					:tabindex="selectable ? -1 : undefined"
					:aria-selected="focused"
					:to="selectable ? undefined : `/dashboard/postbox/${folderRole}/${msg._id}${listQuery}`"
					class="pbx-row-link block w-full text-left px-4 py-3 hover:bg-(--surface-1-hover)"
					:class="{
						'bg-(--surface-1-selected)': active,
						'bg-brand/5': shownSelected,
						'opacity-40': sweepMark === 'archive',
						'ring-1 ring-inset ring-brand/50': focused,
						'cursor-pointer': selectable,
						'pbx-row-settle': gestures.settling.value,
					}"
					:style="gestures.rowStyle.value"
					@click="selectable ? emit('select') : undefined"
				>
					<div class="flex items-start gap-2">
						<button
							type="button"
							class="pbx-row-checkbox mt-0.5 w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center"
							:class="
								shownSelected
									? 'bg-brand border-brand text-text-inverse'
									: 'border-border-subtle bg-bg-base opacity-0 group-hover:opacity-100'
							"
							:aria-label="
								selected
									? t('components.postbox.postboxThreadRow.deselect')
									: t('components.postbox.postboxThreadRow.select')
							"
							:title="t('components.postbox.postboxThreadRow.selectSweepHint')"
							data-sweep-handle="select"
							@click="onCheckboxClick($event)"
						>
							<Icon v-if="shownSelected" name="lucide:check" class="w-3 h-3" />
						</button>
						<UiAvatar
							:name="msg.fromName"
							:email="msg.fromAddress"
							deterministic-color
							size="sm"
							class="flex-shrink-0"
							aria-hidden="true"
						/>
						<PostboxThreadRowBody
							:msg="msg"
							:trust-markers="trustMarkers"
							follow-up-cancelable
							@cancel-follow-up="emit('cancel-follow-up')"
						/>
					</div>
				</component>
				<!-- Hover quick-actions (single-message triage without a round-trip
		     through the bulk selection). -->
				<div
					class="ui-hover-reveal absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-0.5 bg-bg-elevated/95 rounded px-1 py-0.5 shadow-sm border border-border-subtle"
				>
					<button
						v-if="isWhyHereShown"
						type="button"
						class="p-1 rounded hover:bg-bg-surface text-text-tertiary hover:text-text-primary"
						:title="t('postbox.explain.rowLink')"
						:aria-label="t('postbox.explain.rowLink')"
						data-testid="row-why-here"
						@click="openWhyHere($event)"
					>
						<Icon name="lucide:help-circle" class="w-4 h-4" />
					</button>
					<button
						type="button"
						class="p-1 rounded hover:bg-bg-surface text-text-tertiary hover:text-warning"
						:title="
							msg.flagFlagged
								? t('components.postbox.postboxThreadRow.unstar')
								: t('components.postbox.postboxThreadRow.star')
						"
						:aria-label="
							msg.flagFlagged
								? t('components.postbox.postboxThreadRow.unstar')
								: t('components.postbox.postboxThreadRow.star')
						"
						@click="rowAction($event, 'toggle-star')"
					>
						<Icon name="lucide:star" class="w-4 h-4" />
					</button>
					<button
						type="button"
						class="p-1 rounded hover:bg-bg-surface text-text-tertiary hover:text-text-primary"
						:title="
							msg.flagSeen
								? t('components.postbox.postboxThreadRow.markUnread')
								: t('components.postbox.postboxThreadRow.markRead')
						"
						:aria-label="
							msg.flagSeen
								? t('components.postbox.postboxThreadRow.markUnread')
								: t('components.postbox.postboxThreadRow.markRead')
						"
						@click="rowAction($event, 'toggle-read')"
					>
						<Icon :name="msg.flagSeen ? 'lucide:mail' : 'lucide:mail-open'" class="w-4 h-4" />
					</button>
					<button
						type="button"
						class="p-1 rounded hover:bg-bg-surface text-text-tertiary hover:text-text-primary"
						:title="t('components.postbox.postboxThreadRow.archiveSweepHint')"
						:aria-label="t('common.archive')"
						data-sweep-handle="archive"
						@click="rowAction($event, 'archive')"
					>
						<Icon name="lucide:archive" class="w-4 h-4" />
					</button>
					<button
						type="button"
						class="p-1 rounded hover:bg-error/10 text-text-tertiary hover:text-error"
						:title="t('common.delete')"
						:aria-label="t('common.delete')"
						@click="rowAction($event, 'trash')"
					>
						<Icon name="lucide:trash" class="w-4 h-4" />
					</button>
				</div>
			</li>
		</template>
	</UiContextMenu>
</template>
