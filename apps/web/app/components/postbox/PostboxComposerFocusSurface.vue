<script setup lang="ts">
/**
 * The centered distraction-free compose surface.
 *
 * Renders a bg-deep scrim and an always-present teleport target
 * (`#pbx-focus-mount`) into which the active PostboxComposerPopup relocates its
 * body when promoted (Cmd/Ctrl+Shift+F). Because the composer instance is only
 * teleported — never remounted — the draft, ghost text, coach, attachments,
 * schedule and undo-send all keep working; only the frame changes. Esc (or a
 * scrim click) demotes it back to the popup with state intact.
 *
 * The mount stays in the DOM at all times (hidden, pointer-events gated) so the
 * teleport target never disappears mid-transition.
 */
import { isFocusComposeChord } from '~/utils/postboxShortcuts';

const stack = usePostboxComposerStack();
const focusedId = stack.focusedId;

function onKeydown(event: KeyboardEvent) {
	if (isFocusComposeChord(event)) {
		// Only meaningful when something is open; toggleFocusActive no-ops otherwise.
		if (stack.activeComposerId.value) {
			event.preventDefault();
			stack.toggleFocusActive();
		}
		return;
	}
	// Esc backstop: demote from the focus surface even when focus isn't inside
	// the composer editor (e.g. after a scrim click). Capture + stop so it
	// doesn't also close the underlying reader.
	if (event.key === 'Escape' && focusedId.value) {
		event.preventDefault();
		event.stopPropagation();
		stack.unfocus();
	}
}

onMounted(() => window.addEventListener('keydown', onKeydown, true));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true));
</script>

<template>
	<!-- Scrim + frame sit at z-50, one level above every floating popup and the
	     dock (z-40), so promoting one composer while others are open cleanly
	     covers them: the distraction-free surface keeps a single focal point
	     (brief rule 1) instead of other popups/chips bleeding over the scrim. -->
	<Transition name="pbx-focus-scrim">
		<div
			v-if="focusedId"
			class="fixed inset-0 z-50 bg-bg-deep/80 backdrop-blur-sm"
			aria-hidden="true"
			@click="stack.unfocus()"
		/>
	</Transition>
	<div
		class="pbx-focus-frame fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-6 sm:p-10 pointer-events-none"
		:class="{ 'is-focused': focusedId }"
	>
		<div id="pbx-focus-mount" class="w-full max-w-2xl pointer-events-auto" />
	</div>
</template>
