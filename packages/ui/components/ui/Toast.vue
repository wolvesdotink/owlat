<script setup lang="ts">
const { toasts, removeToast } = useToast();
</script>

<template>
	<Teleport to="body">
		<!-- role=status + aria-live: toasts were invisible to assistive tech.
		     The live region exists permanently (required for announcements);
		     each toast's text is announced politely as it is appended. -->
		<div class="fixed bottom-6 right-6 z-50 flex flex-col gap-3" role="status" aria-live="polite">
			<TransitionGroup name="toast">
				<div
					v-for="toast in toasts"
					:key="toast.id"
					:class="[
						'flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg border min-w-[280px] max-w-md',
						toast.type === 'success'
							? 'bg-success-subtle border-success/20'
							: 'bg-error-subtle border-error/20',
					]"
				>
					<!-- Icon -->
					<div
						:class="[
							'size-7 rounded-full flex-shrink-0 flex items-center justify-center',
							toast.type === 'success' ? 'bg-success/20' : 'bg-error/20',
						]"
					>
						<Icon
							v-if="toast.type === 'success'"
							name="lucide:check"
							size="16"
							class="text-success"
						/>
						<Icon v-else name="lucide:alert-circle" size="16" class="text-error" />
					</div>

					<!-- Message -->
					<p
						:class="[
							'text-sm font-medium flex-1',
							toast.type === 'success' ? 'text-success' : 'text-error',
						]"
					>
						{{ toast.message }}
					</p>

					<!-- Optional inline action (e.g. "Undo") — clicking it dismisses the toast -->
					<button
						v-if="toast.action"
						type="button"
						:class="[
							'text-sm font-semibold flex-shrink-0 px-2 py-1 rounded-lg transition-colors hover:underline',
							toast.type === 'success'
								? 'text-success hover:bg-success/20'
								: 'text-error hover:bg-error/20',
						]"
						@click="
							toast.action.onAction();
							removeToast(toast.id);
						"
					>
						{{ toast.action.label }}
					</button>

					<!-- Close button (optional - auto-dismisses but allows manual close) -->
					<button
						:class="[
							'p-1 rounded-lg transition-colors flex-shrink-0',
							toast.type === 'success'
								? 'hover:bg-success/20 text-success'
								: 'hover:bg-error/20 text-error',
						]"
						@click="removeToast(toast.id)"
					>
						<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								d="M6 18L18 6M6 6l12 12"
							/>
						</svg>
					</button>
				</div>
			</TransitionGroup>
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
