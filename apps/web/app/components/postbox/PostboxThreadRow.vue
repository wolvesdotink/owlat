<script lang="ts">
import type { Id } from '@owlat/api/dataModel';
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
 */
import type { ContextMenuItem } from '@owlat/ui/components/ui/ContextMenu.vue';
import { deriveSenderRowMarker, senderRiskInputOf, type SenderAuthText } from '~/utils/senderAuth';

const { t, locale } = useI18n();

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
	/**
	 * The pointer or the focus ring landed on this row — the list warms its body
	 * (debounced, so a sweep across the list costs one round-trip, not one per
	 * row it passes over).
	 */
	prefetch: [];
}>();

const rowId = computed(() => `postbox-row-${props.msg._id}`);

/**
 * Danger-only sender-trust marker (UX plan idea 51). Triage is where phishing
 * gets clicked, and the five-state verdict used to render only inside an opened
 * thread. `deriveSenderRowMarker` stays silent for verified, unauthenticated and
 * legacy rows — the list must not become a wall of shields — so this is null on
 * the overwhelming majority of rows.
 */
const trustMarker = computed(() =>
	props.trustMarkers ? deriveSenderRowMarker(senderRiskInputOf(props.msg)) : null
);

/**
 * The marker's full sentence, resolved here: the derivation is module scope and
 * hands back catalog keys (`{ key, params }` when it names a domain).
 */
function markerText(text: SenderAuthText): string {
	return typeof text === 'string' ? t(text) : t(text.key, text.params ?? {});
}

/**
 * The chip's accessible name. The compact density hides the visible label to
 * keep a one-line row one line, so the name has to carry BOTH halves — the
 * short summary and why — or a screen reader would hear a bare warning icon.
 */
const trustMarkerLabel = computed(() => {
	const marker = trustMarker.value;
	if (!marker) return '';
	return `${t(marker.label)} — ${markerText(marker.title)}`;
});

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

/** Absolute wake time of a snoozed row, formatted against the active locale. */
function snoozedTitle(until: number): string {
	return t('components.postbox.postboxThreadRow.snoozedUntil', {
		when: new Date(until).toLocaleString(locale.value),
	});
}

// ── Touch entry point: long-press opens the SAME context menu ──
// On touch devices the hover-reveal actions stay visible at rest
// (postbox-density.css), but the triage verbs' second entry point — the
// right-click menu — never fires. Per the mailbox plan this is wiring, not
// new UI: a ~500ms hold re-dispatches the row's own `contextmenu` event at
// the touch point, so UiContextMenu's existing open-at-position path (with
// its focus trap, Esc handling and action source) runs unchanged.
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 8;
let pressTimer: ReturnType<typeof setTimeout> | null = null;
let pressOrigin: { x: number; y: number } | null = null;
/** Set when the long-press fired, so the finger-lift click doesn't navigate. */
let suppressNextClick = false;

function cancelLongPress() {
	if (pressTimer !== null) {
		clearTimeout(pressTimer);
		pressTimer = null;
	}
	pressOrigin = null;
}

function onRowPointerdown(event: PointerEvent) {
	// Mice already own right-click; multi-touch secondary points are ignored;
	// taps on the row's own buttons (checkbox, quick actions) handle themselves.
	if (event.pointerType === 'mouse' || !event.isPrimary) return;
	if ((event.target as HTMLElement | null)?.closest('button')) return;
	// A new press starts clean: the previous long-press's click may have been
	// swallowed by the menu's backdrop (dismiss by tapping outside, or Esc)
	// rather than reaching this row, which would otherwise leave the flag set
	// and eat the next legitimate tap.
	suppressNextClick = false;
	cancelLongPress();
	pressOrigin = { x: event.clientX, y: event.clientY };
	const row = event.currentTarget as HTMLElement;
	pressTimer = setTimeout(() => {
		pressTimer = null;
		suppressNextClick = true;
		row.dispatchEvent(
			new MouseEvent('contextmenu', {
				bubbles: true,
				cancelable: true,
				clientX: pressOrigin?.x ?? 0,
				clientY: pressOrigin?.y ?? 0,
			})
		);
	}, LONG_PRESS_MS);
}

/** A drag past the slop is a scroll, not a hold — stand down. */
function onRowPointermove(event: PointerEvent) {
	if (!pressOrigin || pressTimer === null) return;
	if (
		Math.abs(event.clientX - pressOrigin.x) > LONG_PRESS_SLOP_PX ||
		Math.abs(event.clientY - pressOrigin.y) > LONG_PRESS_SLOP_PX
	) {
		cancelLongPress();
	}
}

/** Swallow the click that follows a fired long-press (it would open the row). */
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
	if (!suppressNextClick) return;
	suppressNextClick = false;
	event.preventDefault();
	event.stopPropagation();
}

onUnmounted(cancelLongPress);
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
				:class="{ 'pbx-virtual-row': virtualize, 'pbx-row-danger': !!trustMarker }"
				style="
					content-visibility: auto;
					contain-intrinsic-size: auto var(--pbx-row-intrinsic, 76px);
				"
				@contextmenu="onContextmenu"
				@keydown="onKeydown"
				@mouseenter="emit('prefetch')"
				@focusin="emit('prefetch')"
				@pointerdown="onRowPointerdown"
				@pointermove="onRowPointermove"
				@pointerup="cancelLongPress"
				@pointercancel="cancelLongPress"
				@click.capture="onCapturedClick"
			>
				<component
					:is="selectable ? 'div' : (resolveComponent('NuxtLink') as 'div')"
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
					}"
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
						<PostboxRowCore :unread="!msg.flagSeen">
							<template #identifier>{{ msg.fromName || msg.fromAddress }}</template>
							<template #meta>{{ formatThreadTimestamp(msg.receivedAt) }}</template>
							<div class="flex items-center gap-1.5 mt-0.5">
								<!-- Danger-only sender marker: failed / misaligned / look-alike of a
								     known contact's domain. Silent for every other verdict. -->
								<span
									v-if="trustMarker"
									class="pbx-row-trust inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border border-error/40 text-error whitespace-nowrap flex-shrink-0"
									data-testid="row-trust-marker"
									:title="trustMarkerLabel"
									:aria-label="trustMarkerLabel"
								>
									<Icon :name="trustMarker.icon" class="w-3 h-3" />
									<span class="pbx-row-trust-label">{{ t(trustMarker.label) }}</span>
								</span>
								<Icon v-if="msg.flagFlagged" name="lucide:star" class="w-3.5 h-3.5 text-warning" />
								<Icon
									v-if="msg.snoozedUntil"
									name="lucide:clock"
									class="w-3.5 h-3.5 text-brand"
									:title="snoozedTitle(msg.snoozedUntil)"
								/>
								<!-- Muted conversation: the reason this thread is quiet, said
								     out loud rather than left as a mystery. -->
								<Icon
									v-if="msg.mutedAt"
									name="lucide:bell-off"
									class="w-3.5 h-3.5 text-text-tertiary"
									:title="t('components.postbox.postboxThreadRow.mutedChip')"
									:aria-label="t('components.postbox.postboxThreadRow.mutedChip')"
								/>
								<!-- Transient "you asked for this back" cue, cleared on open. -->
								<span
									v-if="msg.snoozeReturnedAt && !msg.snoozedUntil"
									class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border border-border-subtle text-text-tertiary whitespace-nowrap"
								>
									<Icon name="lucide:undo-2" class="w-3 h-3" />
									{{ t('components.postbox.postboxThreadRow.backFromSnooze') }}
								</span>
								<Icon
									v-if="msg.hasAttachments"
									name="lucide:paperclip"
									class="w-3.5 h-3.5 text-text-tertiary"
								/>
								<PostboxThreadRowFollowUp
									v-if="msg.followUp?.watched"
									:follow-up="msg.followUp"
									@cancel="
										(e: MouseEvent) => {
											e.stopPropagation();
											e.preventDefault();
											emit('cancel-follow-up');
										}
									"
								/>
								<p
									class="truncate text-sm flex-1"
									:class="msg.flagSeen ? 'text-text-secondary' : 'font-medium text-text-primary'"
								>
									{{ msg.subject || t('components.postbox.postboxThreadRow.noSubject') }}
								</p>
							</div>
							<p class="pbx-row-snippet text-xs text-text-tertiary truncate mt-0.5">
								{{ msg.snippet }}
							</p>
						</PostboxRowCore>
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
