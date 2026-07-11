<script setup lang="ts">
import { computed } from 'vue';
import type { Toast, ToastType } from '../../composables/useToast';

/**
 * A single toast card. Extracted from {@link Toast.vue} so the same markup can
 * be rendered inside two separate ARIA live regions (assertive for errors,
 * polite for everything else) without duplicating the template.
 */
const props = defineProps<{ toast: Toast }>();

const emit = defineEmits<{ dismiss: [] }>();

interface ToastStyle {
	container: string;
	iconWrap: string;
	icon: string;
	iconColor: string;
	text: string;
	actionHover: string;
	closeHover: string;
}

/**
 * Per-type colour + icon, all via Fluid Functionalism semantic tokens. Modelled
 * as an exhaustive {@link Record} (matching IconBox.vue) so adding a fifth
 * {@link ToastType} is a compile error rather than silently rendering as
 * success. Full literal class strings are kept so Tailwind's scanner sees them.
 */
const STYLES: Record<ToastType, ToastStyle> = {
	success: {
		container: 'bg-success-subtle border-success/20',
		iconWrap: 'bg-success/20',
		icon: 'lucide:check',
		iconColor: 'text-success',
		text: 'text-success',
		actionHover: 'text-success hover:bg-success/20',
		closeHover: 'hover:bg-success/20 text-success',
	},
	error: {
		container: 'bg-error-subtle border-error/20',
		iconWrap: 'bg-error/20',
		icon: 'lucide:alert-circle',
		iconColor: 'text-error',
		text: 'text-error',
		actionHover: 'text-error hover:bg-error/20',
		closeHover: 'hover:bg-error/20 text-error',
	},
	warning: {
		container: 'bg-warning-subtle border-warning/20',
		iconWrap: 'bg-warning/20',
		icon: 'lucide:alert-triangle',
		iconColor: 'text-warning',
		text: 'text-warning',
		actionHover: 'text-warning hover:bg-warning/20',
		closeHover: 'hover:bg-warning/20 text-warning',
	},
	info: {
		container: 'bg-info-subtle border-info/20',
		iconWrap: 'bg-info/20',
		icon: 'lucide:info',
		iconColor: 'text-info',
		text: 'text-info',
		actionHover: 'text-info hover:bg-info/20',
		closeHover: 'hover:bg-info/20 text-info',
	},
};

const style = computed(() => STYLES[props.toast.type]);
</script>

<template>
	<div
		:class="[
			'flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg border min-w-[280px] max-w-md',
			style.container,
		]"
	>
		<!-- Icon -->
		<div
			:class="[
				'size-7 rounded-full flex-shrink-0 flex items-center justify-center',
				style.iconWrap,
			]"
		>
			<Icon :name="style.icon" size="16" :class="style.iconColor" />
		</div>

		<!-- Message -->
		<p :class="['text-sm font-medium flex-1', style.text]">
			{{ toast.message }}
		</p>

		<!-- Optional inline action (e.g. "Undo") — clicking it dismisses the toast -->
		<button
			v-if="toast.action"
			type="button"
			:class="[
				'text-sm font-semibold flex-shrink-0 px-2 py-1 rounded-lg transition-colors hover:underline',
				style.actionHover,
			]"
			@click="
				toast.action.onAction();
				emit('dismiss');
			"
		>
			{{ toast.action.label }}
		</button>

		<!-- Close button (optional - auto-dismisses but allows manual close) -->
		<button
			:class="['p-1 rounded-lg transition-colors flex-shrink-0', style.closeHover]"
			aria-label="Dismiss notification"
			@click="emit('dismiss')"
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
</template>
