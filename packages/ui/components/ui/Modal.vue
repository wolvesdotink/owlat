<script setup lang="ts">
import { ref, useId } from 'vue';
import { useModalFocus } from '../../composables/useModalFocus';

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

const sizeClasses: Record<ModalSize, string> = {
	sm: 'max-w-sm',
	md: 'max-w-md',
	lg: 'max-w-lg',
	xl: 'max-w-xl',
	'2xl': 'max-w-2xl',
	'3xl': 'max-w-3xl',
	'4xl': 'max-w-4xl',
	full: 'max-w-[95vw]',
};

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

useModalFocus(
	dialogRef,
	() => props.open,
	() => {
		if (props.closable && !props.persistent) close();
	}
);
</script>

<template>
	<Teleport to="body">
		<Transition name="modal">
			<div
				v-if="open"
				class="fixed inset-0 bg-bg-deep/80 backdrop-blur-sm z-(--z-modal) flex items-center justify-center p-4"
				:style="zIndex !== undefined ? { zIndex } : undefined"
				@click.self="handleBackdropClick"
			>
				<div
					ref="dialogRef"
					role="dialog"
					aria-modal="true"
					:aria-labelledby="title ? titleId : undefined"
					:class="[
						'bg-bg-elevated border border-border-subtle rounded-2xl shadow-xl w-full',
						sizeClasses[size],
					]"
				>
					<!-- Header -->
					<div
						v-if="title || closable"
						class="flex items-center justify-between p-6 border-b border-border-subtle"
					>
						<h2 v-if="title" :id="titleId" class="text-lg font-semibold text-text-primary">
							{{ title }}
						</h2>
						<div v-else />
						<button
							v-if="closable"
							class="p-2 hover:bg-bg-surface rounded-lg transition-colors"
							type="button"
							aria-label="Close dialog"
							@click="close"
						>
							<Icon name="lucide:x" class="w-5 h-5 text-text-tertiary" />
						</button>
					</div>

					<!-- Body -->
					<div class="p-6">
						<slot />
					</div>

					<!-- Footer -->
					<div v-if="$slots['footer']" class="flex justify-end gap-3 p-6 pt-0">
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

.modal-enter-from > div,
.modal-leave-to > div {
	transform: scale(0.95);
}

@media (prefers-reduced-motion: reduce) {
	/* Reduced motion: fade only, no scale. */
	.modal-enter-from > div,
	.modal-leave-to > div {
		transform: none;
	}
}
</style>
