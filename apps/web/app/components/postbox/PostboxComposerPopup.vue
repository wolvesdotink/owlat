<script setup lang="ts">
import type { ComposerSpec } from '~/composables/postbox/usePostboxComposerStack';

const props = defineProps<{
	composer: ComposerSpec;
	/** Right-to-left slot among the floating popups (0 = rightmost / newest). */
	slotIndex: number;
}>();

const stack = usePostboxComposerStack();
const undoSend = usePostboxUndoSend();
const { size, setSize } = usePostboxComposerSize();

const isFocused = computed(() => stack.focusedId.value === props.composer.id);

// Floating popup box geometry: persisted size, anchored bottom-right and offset
// left by its slot. Docked/minimized composers are rendered by the dock, so this
// component only ever handles a floating popup.
const popupStyle = computed(() => ({
	width: `${size.value.width}px`,
	height: `${size.value.height}px`,
	right: `${24 + props.slotIndex * (size.value.width + 16)}px`,
	bottom: 'var(--pbx-composer-inset-bottom, 0px)',
}));

function onSent(composerId: string, undoToken: string, sendAt: number, mailboxId: string) {
	stack.close(composerId);
	undoSend.arm({
		undoToken,
		sendAt,
		mailboxId: mailboxId as import('@owlat/api/dataModel').Id<'mailboxes'>,
	});
}

// Esc / header Minimize: while focused, demote back to the popup (state intact);
// otherwise dock the composer as usual.
function onMinimize() {
	if (isFocused.value) stack.unfocus();
	else stack.minimize(props.composer.id);
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
	<!-- role="dialog" both for a11y and so the reader's single-key shortcut
	     handler defers to the composer (its [role="dialog"] guard): focus on a
	     non-editable control here (Send, remove-attachment) must never let
	     e/# archive/trash the message being replied to.

	     Teleport relocates THIS SAME element (and the composer instance inside)
	     into the centered focus surface when promoted — the frame changes, the
	     draft state does not. Disabled = it stays a bottom-right popup. -->
	<Teleport to="#pbx-focus-mount" :disabled="!isFocused">
		<Transition name="pbx-popup" appear>
			<div
				role="dialog"
				aria-label="Compose message"
				class="flex flex-col z-40 bg-bg-elevated border border-border-subtle overflow-hidden"
				:class="
					isFocused
						? 'relative w-full max-w-2xl rounded-md shadow-lg max-h-[85vh]'
						: 'fixed rounded-t-md shadow-lg'
				"
				:style="isFocused ? undefined : popupStyle"
			>
				<!-- Resize grip (top-left corner) — hidden on the focus surface,
				     which sizes itself. Keyboard users resize via the OS-standard
				     drag; the grip is a pointer affordance layered over the header. -->
				<div
					v-if="!isFocused"
					class="absolute top-0 left-0 w-4 h-4 z-50 cursor-nwse-resize touch-none"
					aria-hidden="true"
					title="Drag to resize"
					@pointerdown="onResizeDown"
				/>
				<PostboxComposer
					:mailbox-id="composer.mailboxId"
					:draft-id="composer.draftId"
					:in-reply-to-message-id="composer.inReplyToMessageId"
					:prefill-to="composer.prefillTo"
					:prefill-cc="composer.prefillCc"
					:prefill-bcc="composer.prefillBcc"
					:prefill-subject="composer.prefillSubject"
					:prefill-body-html="composer.prefillBodyHtml"
					:forward-attachments-from-message-id="composer.forwardAttachmentsFromMessageId"
					:attach-pending-key="composer.attachPendingKey"
					:reply-all-recipients="composer.replyAllRecipients"
					@sent="(token, sendAt) => onSent(composer.id, token, sendAt, composer.mailboxId)"
					@discarded="stack.close(composer.id)"
					@minimize="onMinimize"
				/>
			</div>
		</Transition>
	</Teleport>
</template>
