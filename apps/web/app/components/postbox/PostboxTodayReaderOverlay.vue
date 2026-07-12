<script setup lang="ts">
/**
 * Centered reader overlay for the Today view: opening a row keeps the focused
 * single-column list mounted underneath (scroll + j/k selection preserved) and
 * renders the full PostboxThreadReader in an elevated max-w-2xl pane over a
 * bg-deep scrim. One task at a time — the list is context, the pane is the
 * doing-surface.
 *
 * Keyboard contract (window-level, mirroring the list/reader vocabulary):
 *   - Esc / scrim click → `close` (the host restores the list)
 *   - j / k (and ↓ / ↑) → `open` the next / previous row WITHOUT closing —
 *     the host swaps `message` and the keyed pbx-reader transition rides
 *   - every single-key triage/compose shortcut is forwarded to the reader via
 *     the existing `owlat:postbox-reader-action` bridge while focus is inside
 *     the pane (the pane is a [role=dialog], so the reader's own window
 *     handler defers to it by design); with focus outside the pane the
 *     reader's handler picks the key up itself — never both.
 *   - everything defers to nested dialogs (snooze/label/move pickers, the
 *     command palette, shortcut help) and to text-entry targets.
 *
 * Triage auto-advance: the hosted reader gets `advance-in-place`, so
 * archive/trash/snooze swap to the adjacent row (or close at the ends)
 * instead of navigating to the three-pane route.
 */
import { isEditableTarget, resolvePostboxShortcut } from '~/utils/postboxShortcuts';
import type { PostboxReaderMessage } from './PostboxThreadReader.vue';

const props = defineProps<{
	/** The open row (full list-row shape — handed straight to the reader). */
	message: PostboxReaderMessage;
	/** Visible Today-list order (today rows + expanded past rows) for j/k + auto-advance. */
	advanceIds: string[];
}>();

const emit = defineEmits<{
	/** Esc / scrim / advance-past-the-ends: back to the list. */
	close: [];
	/** Swap the reader to this row in place (j/k or triage auto-advance). */
	open: [messageId: string];
}>();

const paneEl = ref<HTMLElement | null>(null);

/** Step to the adjacent visible row; no-op off the ends or on unknown ids. */
function step(delta: 1 | -1) {
	const index = props.advanceIds.indexOf(props.message._id);
	if (index === -1) return;
	const next = props.advanceIds[index + delta];
	if (next) emit('open', next);
}

function onAdvance(target: string | null) {
	if (target) emit('open', target);
	else emit('close');
}

/**
 * True while any OTHER dialog is up (nested pickers teleport to body; the
 * inline ones render inside the pane) — they own Esc and every other key.
 */
function anotherDialogOpen(): boolean {
	return Array.from(document.querySelectorAll('[role="dialog"]')).some((el) => el !== paneEl.value);
}

function onWindowKeydown(event: KeyboardEvent) {
	if (event.defaultPrevented) return;
	if (event.metaKey || event.ctrlKey || event.altKey) return;
	if (isEditableTarget(event.target)) return;
	if (anotherDialogOpen()) return;
	if (event.key === 'Escape') {
		event.preventDefault();
		emit('close');
		return;
	}
	if (event.key === 'j' || event.key === 'ArrowDown') {
		event.preventDefault();
		step(1);
		return;
	}
	if (event.key === 'k' || event.key === 'ArrowUp') {
		event.preventDefault();
		step(-1);
		return;
	}
	// Focus inside the pane: the reader's window handler defers to the
	// [role=dialog] it is hosted in, so forward the shared triage/compose
	// vocabulary over the same bridge the command palette uses. With focus
	// elsewhere (body after a click on the scrim padding, etc.) the reader's
	// own handler resolves the key — skip to avoid double-running it.
	const el = event.target as HTMLElement | null;
	if (!paneEl.value || !el || !paneEl.value.contains(el)) return;
	const action = resolvePostboxShortcut(event.key);
	// '?' stays with the window-level PostboxShortcutHelp listener.
	if (!action || action === 'help') return;
	event.preventDefault();
	window.dispatchEvent(new CustomEvent('owlat:postbox-reader-action', { detail: { action } }));
}

// Focus the pane on open so list/row shortcuts stop landing on the listbox
// underneath; hand focus back to the opener (the listbox in the keyboard
// flow) on close so j/k continue from the preserved selection.
let openerEl: HTMLElement | null = null;
onMounted(() => {
	openerEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	window.addEventListener('keydown', onWindowKeydown);
	nextTick(() => paneEl.value?.focus());
});
onUnmounted(() => {
	window.removeEventListener('keydown', onWindowKeydown);
	if (openerEl && openerEl !== document.body && openerEl.isConnected) {
		openerEl.focus();
		return;
	}
	// Click-opened rows aren't focusable — fall back to the row's listbox so
	// the keyboard flow resumes at the preserved selection.
	const row = document.getElementById(`postbox-row-${props.message._id}`);
	const listbox = row?.closest('[role="listbox"]');
	if (listbox instanceof HTMLElement) listbox.focus();
});
</script>

<template>
	<!-- z-30: above the Today column, below composer popups (z-40) and the
	     dialog/toast layer (z-50) so reply popups + pickers stay usable. -->
	<div
		class="fixed inset-0 z-30 overflow-y-auto p-4 sm:p-8 pt-[calc(var(--titlebar-h,0px)+1rem)] sm:pt-[calc(var(--titlebar-h,0px)+2rem)]"
		data-postbox-today-overlay
	>
		<!-- Scrim: click = back to the list (Esc twin). -->
		<div
			class="fixed inset-0 bg-bg-deep/60 backdrop-blur-sm"
			aria-hidden="true"
			data-overlay-scrim
			@click="emit('close')"
		/>
		<div
			ref="paneEl"
			role="dialog"
			aria-modal="true"
			:aria-label="message.subject || 'Conversation'"
			tabindex="-1"
			class="relative mx-auto w-full max-w-2xl rounded-xl border border-border-subtle bg-bg-elevated shadow-(--shadow-6) outline-none focus-visible:ring-1 focus-visible:ring-brand/40"
		>
			<!-- Keyed swap: j/k and triage auto-advance replace the thread in
			     place with the same fade+rise the three-pane reader uses
			     (opacity-only under prefers-reduced-motion). -->
			<Transition name="pbx-reader" mode="out-in">
				<PostboxThreadReader
					:key="message._id"
					:message="message"
					:advance-ids="advanceIds"
					folder-role="inbox"
					advance-in-place
					@advance="onAdvance"
				/>
			</Transition>
		</div>
	</div>
</template>
