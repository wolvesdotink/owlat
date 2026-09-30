<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import type { ComposerSpec } from '~/composables/postbox/usePostboxComposerStack';
import { useAnswerModeNav } from '~/composables/useAnswerMode';
import { useKeyboardInset } from '~/composables/useKeyboardInset';
import { useMediaQuery } from '~/composables/useMediaQuery';
import { COMPOSER_SHEET_QUERY, popupComposerGeometry } from '~/utils/postboxComposerLayout';

const props = defineProps<{
	composer: ComposerSpec;
	/** Right-to-left slot among the floating popups (0 = rightmost / newest). */
	slotIndex: number;
}>();

const { t } = useI18n();

const stack = usePostboxComposerStack();
const { size, setSize } = usePostboxComposerSize();

// Floating popup geometry: on a wide screen the persisted size, anchored
// bottom-right and offset left by its slot; on a phone a full-width bottom
// sheet over the keyboard. Docked/minimized composers are rendered by the
// dock, so this component only ever handles a floating popup.
const isSmallScreen = useMediaQuery(COMPOSER_SHEET_QUERY);
const keyboard = useKeyboardInset();
const geometry = computed(() =>
	popupComposerGeometry({
		size: size.value,
		slotIndex: props.slotIndex,
		sheet: isSmallScreen.value,
		keyboardInset: keyboard.value,
	})
);

// Esc / header Minimize: dock the composer.
function onMinimize() {
	stack.minimize(props.composer.id);
}

// Esc anywhere in the popup docks it, unless a popover inside (the footer's ⋯,
// a trust chip) already closed on this press and claimed it.
function onEscape(event: KeyboardEvent) {
	if (event.defaultPrevented) return;
	event.preventDefault();
	event.stopPropagation();
	onMinimize();
}

// A reply's maximise continues the SAME draft (saved by the composer first) in
// Answer mode; the popup steps aside.
const answerNav = useAnswerModeNav();
function onMaximise(draftId: Id<'mailDrafts'>) {
	const messageId = props.composer.inReplyToMessageId;
	if (!messageId) return;
	stack.close(props.composer.id);
	void answerNav.open(messageId, { draftId });
}

// --- Drag-to-resize (top-left grip, since the box is anchored bottom-right).
// Dragging left/up grows the box; every frame is clamped + persisted.
let startX = 0;
let startY = 0;
let startW = 0;
let startH = 0;

function onResizeMove(event: PointerEvent) {
	setSize({
		width: startW + (startX - event.clientX),
		height: startH + (startY - event.clientY),
	});
}

function onResizeUp(event: PointerEvent) {
	(event.target as HTMLElement).releasePointerCapture?.(event.pointerId);
	window.removeEventListener('pointermove', onResizeMove);
	window.removeEventListener('pointerup', onResizeUp);
}

function onResizeDown(event: PointerEvent) {
	event.preventDefault();
	startX = event.clientX;
	startY = event.clientY;
	startW = size.value.width;
	startH = size.value.height;
	(event.target as HTMLElement).setPointerCapture?.(event.pointerId);
	window.addEventListener('pointermove', onResizeMove);
	window.addEventListener('pointerup', onResizeUp);
}

onBeforeUnmount(() => {
	window.removeEventListener('pointermove', onResizeMove);
	window.removeEventListener('pointerup', onResizeUp);
});
</script>

<template>
	<!-- Floating composers are nonmodal. -->
	<Transition name="pbx-popup" appear>
		<div
			role="region"
			data-shortcut-boundary
			@keydown.esc="onEscape"
			:aria-label="t('components.postbox.postboxComposerPopup.dialogLabel')"
			class="fixed flex flex-col z-40 bg-bg-elevated border-border-subtle overflow-hidden shadow-lg"
			:class="geometry.mode === 'sheet' ? 'rounded-t-xl border-t' : 'rounded-t-md border'"
			:style="geometry.style"
			:data-geometry="geometry.mode"
		>
			<!-- Resize grip (top-left corner). Keyboard users resize via the
			     OS-standard drag; the grip is a pointer affordance layered over the
			     header. A sheet already spans the screen: nothing to resize. -->
			<div
				v-if="geometry.mode === 'box'"
				class="absolute top-0 left-0 w-4 h-4 z-50 cursor-nwse-resize touch-none"
				aria-hidden="true"
				:title="t('components.postbox.postboxComposerPopup.resizeHandle')"
				@pointerdown="onResizeDown"
			/>
			<!-- The composer arms the undo window itself; a sent popup only closes. -->
			<PostboxComposer
				:seed="composer"
				:reply-all-recipients="composer.replyAllRecipients"
				@sent="stack.close(composer.id)"
				@discarded="stack.close(composer.id)"
				@minimize="onMinimize"
				@maximise="onMaximise"
			/>
		</div>
	</Transition>
</template>
