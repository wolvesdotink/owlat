<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import { useModalFocus } from '../../composables/useModalFocus';
import { useUiI18n } from '../../composables/useUiI18n';

type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl' | 'full';

interface Props {
	open: boolean;
	title?: string;
	size?: ModalSize;
	closable?: boolean;
	persistent?: boolean;
	/** Custom z-index for rendering above high-z elements like the email builder */
	zIndex?: number;
}

const props = withDefaults(defineProps<Props>(), {
	title: undefined,
	size: 'md',
	closable: true,
	persistent: false,
	zIndex: undefined,
});

const emit = defineEmits<{
	'update:open': [value: boolean];
}>();

/**
 * Width caps start at `sm`, because below that the panel is a bottom sheet and
 * a sheet is full-bleed by definition — a `max-w-sm` cap would leave a hairline
 * of backdrop down both sides of a phone.
 */
const sizeClasses: Record<ModalSize, string> = {
	sm: 'sm:max-w-sm',
	md: 'sm:max-w-md',
	lg: 'sm:max-w-lg',
	xl: 'sm:max-w-xl',
	'2xl': 'sm:max-w-2xl',
	'3xl': 'sm:max-w-3xl',
	'4xl': 'sm:max-w-4xl',
	full: 'sm:max-w-[95vw]',
};

const { t } = useUiI18n();

const dialogRef = ref<HTMLElement | null>(null);
// Unique per instance — the old hardcoded 'modal-title' produced duplicate
// ids (and wrong aria-labelledby targets) whenever two modals stacked.
const titleId = useId();

const close = () => {
	if (props.closable) {
		emit('update:open', false);
	}
};

const handleBackdropClick = () => {
	if (!props.persistent) {
		close();
	}
};

/** A persistent dialog waits on its own buttons: no backdrop, Escape or swipe out. */
const dismissible = computed(() => props.closable && !props.persistent);

/**
 * Swipe-to-dismiss for the bottom sheet.
 *
 * The handle is only an honest affordance if it actually drags, so the grabber
 * follows the pointer and releases into a dismiss past the threshold. Pointer
 * capture keeps the gesture alive once the finger leaves the 40px bar, which is
 * what happens on every real flick.
 */
const DISMISS_RATIO = 0.25;
/** Floor for the threshold, so a short sheet cannot be dismissed by a stray tap. */
const DISMISS_MIN = 64;

const dragOffset = ref(0);
const dragging = ref(false);
let dragStart = 0;

const sheetStyle = computed(() =>
	dragOffset.value > 0 ? { transform: `translateY(${dragOffset.value}px)` } : undefined
);

const startDrag = (event: PointerEvent) => {
	if (!dismissible.value) return;
	dragging.value = true;
	dragStart = event.clientY;
	const handle = event.currentTarget as HTMLElement | null;
	// Not every engine implements capture (happy-dom throws on an unknown
	// pointer id); the gesture degrades to "works while over the handle".
	try {
		handle?.setPointerCapture(event.pointerId);
	} catch {
		/* no capture available */
	}
};

const moveDrag = (event: PointerEvent) => {
	if (!dragging.value) return;
	// Downwards only: an upward drag would tear the sheet off the bottom edge.
	dragOffset.value = Math.max(0, event.clientY - dragStart);
};

const endDrag = () => {
	if (!dragging.value) return;
	dragging.value = false;
	const height = dialogRef.value?.offsetHeight ?? 0;
	const past = dragOffset.value >= Math.max(DISMISS_MIN, height * DISMISS_RATIO);
	dragOffset.value = 0;
	if (past) close();
};

useModalFocus(
	dialogRef,
	() => props.open,
	() => {
		if (dismissible.value) close();
	}
);
</script>

<template>
	<Teleport to="body">
		<Transition name="modal">
			<div
				v-if="open"
				class="fixed inset-0 bg-bg-deep/80 backdrop-blur-sm z-(--z-modal) flex items-end justify-center sm:items-center sm:p-4"
				:style="zIndex !== undefined ? { zIndex } : undefined"
				@click.self="handleBackdropClick"
			>
				<!--
					The panel is a flex column that owns its own scrolling: header and
					footer are pinned, only the body scrolls, and the whole thing is
					capped at 85dvh so a tall dialog can never push its submit button
					past the bottom of the viewport.
				-->
				<div
					ref="dialogRef"
					role="dialog"
					aria-modal="true"
					:aria-labelledby="title ? titleId : undefined"
					:class="[
						'modal-panel bg-bg-elevated border border-border-subtle shadow-xl w-full flex flex-col max-h-[85dvh] rounded-t-2xl sm:rounded-2xl',
						{ 'is-dragging': dragging },
						sizeClasses[size],
					]"
					:style="sheetStyle"
				>
					<!--
						Drag handle — the bottom sheet's grabber; desktop has no sheet.
						Hidden from assistive tech: it is a bar with no name, and the
						gesture it offers is a shortcut for the close button and Escape,
						both of which sit right there.
					-->
					<div
						v-if="dismissible"
						aria-hidden="true"
						class="modal-grip shrink-0 flex justify-center pt-3 pb-1 touch-none sm:hidden"
						@pointerdown="startDrag"
						@pointermove="moveDrag"
						@pointerup="endDrag"
						@pointercancel="endDrag"
					>
						<span class="h-1 w-10 rounded-full bg-border-strong" />
					</div>

					<!-- Header -->
					<div
						v-if="title || closable"
						class="shrink-0 flex items-center justify-between p-6 border-b border-border-subtle"
					>
						<h2 v-if="title" :id="titleId" class="text-lg font-semibold text-text-primary">
							{{ title }}
						</h2>
						<div v-else />
						<button
							v-if="closable"
							class="p-2 hover:bg-bg-surface rounded-lg transition-colors"
							type="button"
							:aria-label="t('ui.modal.close')"
							@click="close"
						>
							<Icon name="lucide:x" class="w-5 h-5 text-text-tertiary" />
						</button>
					</div>

					<!-- Body: the only scrolling region -->
					<div class="flex-1 min-h-0 overflow-y-auto overscroll-contain p-6">
						<slot />
					</div>

					<!-- Footer -->
					<div v-if="$slots['footer']" class="shrink-0 flex justify-end gap-3 p-6 pt-0">
						<slot name="footer" />
					</div>
				</div>
			</div>
		</Transition>
	</Teleport>
</template>

<style scoped>
/*
 * Modal transition — slow tier (dialogs are the biggest thing that moves).
 * Enter rides the bouncy spring; the exit is a faster, plain ease-out tween
 * so dismissal reads crisp and final.
 */
.modal-enter-active {
	transition: all var(--motion-slow) var(--ease-spring-bounce);
}

.modal-leave-active {
	transition: all var(--motion-slow-exit) var(--ease-exit);
}

.modal-enter-from,
.modal-leave-to {
	opacity: 0;
}

/*
 * Settling after a swipe that did not clear the dismiss threshold: menu tier,
 * because the sheet is only travelling back a few dozen pixels. The enter and
 * leave rules below outrank it while the dialog itself is animating.
 */
.modal-panel {
	transition: transform var(--motion-moderate) var(--ease-spring);
}

.modal-enter-active .modal-panel {
	transition: transform var(--motion-slow) var(--ease-spring-bounce);
}

.modal-leave-active .modal-panel {
	transition: transform var(--motion-slow-exit) var(--ease-exit);
}

/* A dragging sheet tracks the finger 1:1 — any easing here reads as lag. */
.modal-panel.is-dragging {
	transition: none;
}

.modal-grip {
	cursor: grab;
}

.modal-panel.is-dragging .modal-grip {
	cursor: grabbing;
}

.modal-enter-from .modal-panel,
.modal-leave-to .modal-panel {
	transform: scale(0.95);
}

/*
 * Below Tailwind's `sm` (40rem) the panel is a bottom sheet, so it slides up
 * from the bottom edge instead of scaling in place — the gesture every mobile
 * OS already taught the user.
 */
@media (width < 40rem) {
	.modal-enter-from .modal-panel,
	.modal-leave-to .modal-panel {
		transform: translateY(100%);
	}
}

@media (prefers-reduced-motion: reduce) {
	/* Reduced motion: fade only, no scale and no slide. */
	.modal-panel,
	.modal-enter-active .modal-panel,
	.modal-leave-active .modal-panel {
		transition: none;
	}

	.modal-enter-from .modal-panel,
	.modal-leave-to .modal-panel {
		transform: none;
	}
}
</style>
