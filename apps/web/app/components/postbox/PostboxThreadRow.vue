<script lang="ts">
import { NuxtLink } from '#components';
import type { Doc, Id } from '@owlat/api/dataModel';
import type { SenderAuthMessage } from '~/utils/senderAuth';

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
	// The row's thread just came BACK from snooze (mail/snooze.ts sweep).
	// Transient: the reader clears it the first time the thread is opened.
	snoozeReturnedAt?: number;
	// The thread's advisory smart-inbox category (mail/category.ts), attached
	// server-side so the Today and Bundled views group every page alike.
	category?: NonNullable<Doc<'mailThreads'>['category']>['label'];
	// Parsed List-Unsubscribe target; `oneClick` is what lets a bundle offer one.
	unsubscribe?: { httpUrl?: string; mailtoUrl?: string; oneClick: boolean };
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
import { usePostboxRowGestures } from '~/composables/postbox/usePostboxRowGestures';
import { senderRowMarkerOf } from '~/utils/senderAuth';

const { t } = useI18n();

const props = defineProps<{
	msg: PostboxThreadRowMessage;
	selectable?: boolean;
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
	'cancel-follow-up': [];
	/** A committed swipe (idea 21). The list maps it onto its own triage verbs. */
	swipe: [action: Exclude<PostboxSwipeAction, 'none'>];
	/**
	 * The pointer or the focus ring landed on this row — the list warms its body
	 * (debounced, so a sweep across the list costs one round-trip, not one per
	 * row it passes over).
	 */
	prefetch: [];
}>();

const rowId = computed(() => `postbox-row-${props.msg._id}`);

/** The row accent for a danger-only sender marker; the body renders the chip. */
const isDanger = computed(() => senderRowMarkerOf(props.msg, props.trustMarkers) !== null);

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
function triage(e: 'toggle-star' | 'toggle-read' | 'archive' | 'trash' | 'toggle-mute') {
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
	}
}

/** Stop a hover-action button from following the row's NuxtLink, then triage. */
function rowAction(event: MouseEvent, e: 'toggle-star' | 'toggle-read' | 'archive' | 'trash') {
	event.stopPropagation();
	event.preventDefault();
	triage(e);
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
				role="none"
				class="group relative pbx-row-li"
				:class="{
					'pbx-virtual-row': virtualize,
					'pbx-row-danger': isDanger,
					'pbx-row-swiping': !!gestures.track.value,
				}"
				style="
					content-visibility: auto;
					contain-intrinsic-size: auto var(--pbx-row-intrinsic, 76px);
				"
				@contextmenu="onContextmenu"
				@keydown="onKeydown"
				@mouseenter="emit('prefetch')"
				@focusin="emit('prefetch')"
				@pointerdown="gestures.onPointerdown"
				@pointermove="gestures.onPointermove"
				@pointerup="gestures.onPointerup"
				@pointercancel="gestures.onPointercancel"
				@click.capture="onCapturedClick"
			>
				<!-- Revealed behind the row while it follows the finger sideways. -->
				<PostboxSwipeTrack v-if="gestures.track.value" :track="gestures.track.value" />
				<component
					:is="selectable ? 'div' : NuxtLink"
					:id="rowId"
					role="option"
					:tabindex="selectable ? -1 : undefined"
					:aria-selected="focused"
					:to="selectable ? undefined : `/dashboard/postbox/${folderRole}/${msg._id}`"
					class="pbx-row-link block w-full text-left px-4 py-3 hover:bg-(--surface-1-hover)"
					:class="{
						'bg-(--surface-1-selected)': active,
						'bg-brand/5': selected,
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
								selected
									? 'bg-brand border-brand text-text-inverse'
									: 'border-border-subtle bg-bg-base opacity-0 group-hover:opacity-100'
							"
							:aria-label="
								selected
									? t('components.postbox.postboxThreadRow.deselect')
									: t('components.postbox.postboxThreadRow.select')
							"
							@click="onCheckboxClick($event)"
						>
							<Icon v-if="selected" name="lucide:check" class="w-3 h-3" />
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
						:title="t('common.archive')"
						:aria-label="t('common.archive')"
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
