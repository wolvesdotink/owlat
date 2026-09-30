<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import type { ComposerSpec } from '~/composables/postbox/usePostboxComposerStack';
import { useAnswerModeNav } from '~/composables/useAnswerMode';

const props = defineProps<{
	composer: ComposerSpec;
	/** Right-to-left slot among the floating popups (0 = rightmost / newest). */
	slotIndex: number;
}>();

const { t } = useI18n();

const stack = usePostboxComposerStack();
const { size, setSize } = usePostboxComposerSize();

// Floating popup box geometry: persisted size, anchored bottom-right and offset
// left by its slot. Docked/minimized composers are rendered by the dock, so this
// component only ever handles a floating popup.
const popupStyle = computed(() => ({
	width: `${size.value.width}px`,
	height: `${size.value.height}px`,
	right: `${24 + props.slotIndex * (size.value.width + 16)}px`,
	bottom: 'var(--pbx-composer-inset-bottom, 0px)',
}));

// Esc / header Minimize: dock the composer.
function onMinimize() {
	stack.minimize(props.composer.id);
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
			@keydown.esc.prevent.stop="onMinimize"
			:aria-label="t('components.postbox.postboxComposerPopup.dialogLabel')"
			class="fixed flex flex-col z-40 bg-bg-elevated border border-border-subtle overflow-hidden rounded-t-md shadow-lg"
			:style="popupStyle"
		>
			<!-- Resize grip (top-left corner). Keyboard users resize via the
			     OS-standard drag; the grip is a pointer affordance layered over the
			     header. -->
			<div
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
