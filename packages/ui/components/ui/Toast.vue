<script setup lang="ts">
import { computed } from 'vue';
import { useToast } from '../../composables/useToast';
import ToastItem from './ToastItem.vue';

const { toasts, removeToast } = useToast();

// Errors go in an assertive live region (interrupt the screen reader — the user
// needs to know an action failed now). Everything else stays polite.
const errorToasts = computed(() => toasts.value.filter((t) => t.type === 'error'));
const politeToasts = computed(() => toasts.value.filter((t) => t.type !== 'error'));
</script>

<template>
	<Teleport to="body">
		<div class="fixed bottom-6 right-6 z-50 flex flex-col gap-3">
			<!-- Assertive region: failures interrupt so the user reacts immediately. -->
			<div class="flex flex-col gap-3" role="alert" aria-live="assertive">
				<TransitionGroup name="toast">
					<ToastItem
						v-for="toast in errorToasts"
						:key="toast.id"
						:toast="toast"
						@dismiss="removeToast(toast.id)"
					/>
				</TransitionGroup>
			</div>

			<!-- Polite region: success / info / warning are announced without interrupting. -->
			<div class="flex flex-col gap-3" role="status" aria-live="polite">
				<TransitionGroup name="toast">
					<ToastItem
						v-for="toast in politeToasts"
						:key="toast.id"
						:toast="toast"
						@dismiss="removeToast(toast.id)"
					/>
				</TransitionGroup>
			</div>
		</div>
	</Teleport>
</template>

<style scoped>
/* Toast transition - slide up + fade; exits one notch faster than enters */
.toast-enter-active {
	transition: all var(--motion-fast) var(--ease-spring);
}

.toast-leave-active {
	transition: all var(--motion-fast-exit) var(--ease-exit);
}

.toast-enter-from {
	opacity: 0;
	transform: translateY(1rem);
}

.toast-leave-to {
	opacity: 0;
	transform: translateX(1rem);
}

/* Ensure items animate when siblings are removed */
.toast-move {
	transition: transform var(--motion-moderate) var(--ease-spring);
}
</style>
