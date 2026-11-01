<script setup lang="ts">
import { computed, getCurrentInstance, nextTick, ref, watch, watchPostEffect } from 'vue';
import type { Toast, ToastType } from '../../composables/useToast';
import { useUiI18n } from '../../composables/useUiI18n';
import { useToastReadingTimeHolds } from '../../composables/useToastReadingTime';
import {
	CheckIcon,
	CircleInfoIcon,
	CircleWarningIcon,
	TriangleWarningIcon,
	type IconComponent,
} from '@coolicons/vue';
import { SpinnerIcon } from '../../icons/SpinnerIcon';

/**
 * A single toast card. Extracted from {@link Toast.vue} so the same markup can
 * be rendered inside two separate ARIA live regions (assertive for errors,
 * polite for everything else) without duplicating the template.
 */
const props = defineProps<{ toast: Toast }>();

const emit = defineEmits<{
	/**
	 * The inline action was pressed. Not a dismissal: the stack decides whether
	 * the toast goes (an observed action keeps it up while it runs).
	 */
	action: [];
	/** The close button: the toast goes, whatever its action is doing. */
	close: [];
}>();

interface ToastStyle {
	container: string;
	iconWrap: string;
	icon: IconComponent;
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
		icon: CheckIcon,
		iconColor: 'text-success',
		text: 'text-success',
		actionHover: 'text-success hover:bg-success/20',
		closeHover: 'hover:bg-success/20 text-success',
	},
	error: {
		container: 'bg-error-subtle border-error/20',
		iconWrap: 'bg-error/20',
		icon: CircleWarningIcon,
		iconColor: 'text-error',
		text: 'text-error',
		actionHover: 'text-error hover:bg-error/20',
		closeHover: 'hover:bg-error/20 text-error',
	},
	warning: {
		container: 'bg-warning-subtle border-warning/20',
		iconWrap: 'bg-warning/20',
		icon: TriangleWarningIcon,
		iconColor: 'text-warning',
		text: 'text-warning',
		actionHover: 'text-warning hover:bg-warning/20',
		closeHover: 'hover:bg-warning/20 text-warning',
	},
	info: {
		container: 'bg-info-subtle border-info/20',
		iconWrap: 'bg-info/20',
		icon: CircleInfoIcon,
		iconColor: 'text-info',
		text: 'text-info',
		actionHover: 'text-info hover:bg-info/20',
		closeHover: 'hover:bg-info/20 text-info',
	},
};

// Hovering or focusing the card pauses an ordinary toast's reading time.
const card = useToastReadingTimeHolds(() => props.toast.id);

const { t } = useUiI18n();

/**
 * While an observed action runs, the icon turns into a spinner and the action
 * (now showing its pending label) stops taking pointer presses; a keyboard
 * press is ignored by the toast store. Both are expressed through the style
 * entries so the card's markup stays the same in every state.
 */
const style = computed<ToastStyle>(() => {
	const base = STYLES[props.toast.type];
	if (!props.toast.pending) return base;
	return {
		...base,
		icon: SpinnerIcon,
		iconColor: `${base.iconColor} animate-spin motion-reduce:animate-none`,
		actionHover: `${base.text} opacity-70 cursor-progress pointer-events-none`,
	};
});

const instance = getCurrentInstance();
const closeRef = ref<HTMLButtonElement | null>(null);

/**
 * The inline action button: the card's only button besides close. Found from
 * the component's root element at use time (the card is its single root), so
 * the root needs no template ref of its own for this.
 */
function actionButton(): HTMLButtonElement | undefined {
	const root: unknown = instance?.proxy?.$el;
	if (!(root instanceof HTMLElement)) return undefined;
	return [...root.querySelectorAll('button')].find((b) => b !== closeRef.value);
}

/*
 * An observed action (see ToastObservedAction) does not take the toast with it
 * on press. While it runs, the action reads as disabled (`aria-disabled`, still
 * focusable; the store ignores the press); when it ends without the toast
 * going, the button disappears and focus that was on it moves to close rather
 * than dropping to <body>. Both are kept out of the action button's markup,
 * which is shared with the phone-layout rewrite of this card.
 */
watchPostEffect(() => {
	const button = actionButton();
	if (!button) return;
	if (props.toast.pending) button.setAttribute('aria-disabled', 'true');
	else button.removeAttribute('aria-disabled');
});

watch(
	() => Boolean(props.toast.action),
	(hasAction, hadAction) => {
		// Runs before the DOM update, while the leaving button still holds focus.
		if (hasAction || !hadAction) return;
		const button = actionButton();
		if (!button || button !== document.activeElement) return;
		void nextTick(() => closeRef.value?.focus());
	}
);
</script>

<template>
	<div
		ref="card"
		:data-toast-id="toast.id"
		:class="[
			'pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg border w-full min-w-0 max-w-md sm:min-w-[280px]',
			style.container,
		]"
	>
		<!-- data-toast-id lets a caller find its own toast's action, e.g. to hand
		     focus back to it after a dialog the action opened has closed. -->
		<!-- Icon -->
		<div
			:class="[
				'size-7 rounded-full flex-shrink-0 flex items-center justify-center',
				style.iconWrap,
			]"
		>
			<component :is="style.icon" size="16" :class="style.iconColor" />
		</div>

		<!--
			Message + action wrap as a pair: when both no longer fit on one line (a
			phone, long copy), the action drops below the message instead of
			squeezing it or pushing the card past the screen edge.
		-->
		<div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
			<p :class="['min-w-0 flex-[1_1_10rem] text-sm font-medium break-words', style.text]">
				{{ toast.message
				}}<span v-if="toast.shortcutHint" class="font-normal opacity-80 pointer-coarse:hidden">
					· {{ toast.shortcutHint }}</span
				>
			</p>

			<!-- Optional inline action (e.g. "Undo") — a plain one dismisses the toast; an observed one keeps it until its outcome -->
			<button
				v-if="toast.action"
				type="button"
				:class="[
					'text-sm font-semibold text-left max-w-full break-words px-2 py-1 rounded-lg transition-colors hover:underline',
					style.actionHover,
				]"
				@click="
					toast.action.onAction();
					emit('action');
				"
			>
				{{ toast.action.label }}
			</button>
		</div>

		<!-- Close button (optional - auto-dismisses but allows manual close) -->
		<button
			ref="closeRef"
			:class="['p-1 rounded-lg transition-colors flex-shrink-0', style.closeHover]"
			:aria-label="t('ui.toast.dismiss')"
			@click="emit('close')"
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
