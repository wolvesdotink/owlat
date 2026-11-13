<script setup lang="ts">
import UiTooltip from '@owlat/ui/components/ui/Tooltip.vue';
import { nextTick, onMounted, ref } from 'vue';
import { CloseIcon } from '@coolicons/vue';
import { useBuilderI18n } from '../i18n/useBuilderI18n';

const { t } = useBuilderI18n();

defineProps<{
	isFocusMode: boolean;
	showHint: boolean;
	isSaving: boolean;
}>();

const emit = defineEmits<{
	(e: 'exit'): void;
}>();

// Entering focus mode makes the header inert; when the focus-mode button that
// was just pressed sat in it, focus fell to <body>. Hand it to the exit button.
const exitButtonRef = ref<HTMLButtonElement | null>(null);
onMounted(() => {
	nextTick(() => {
		const active = document.activeElement;
		if (!active || active === document.body || active.closest('[inert]')) {
			exitButtonRef.value?.focus({ preventScroll: true });
		}
	});
});
</script>

<template>
	<!-- Focus Mode Keyboard Shortcut Hint (shows briefly when entering focus mode).
	     The live region stays mounted so the hint is announced when it appears. -->
	<div role="status" class="contents">
		<Transition
			enter-active-class="transition-[opacity,translate] duration-(--motion-moderate) ease-spring"
			leave-active-class="transition-[opacity,translate] duration-(--motion-slow-exit) ease-exit"
			enter-from-class="opacity-0 -translate-y-2.5"
			leave-to-class="opacity-0 -translate-y-[5px]"
		>
			<div
				v-if="showHint"
				class="fixed top-[calc(var(--titlebar-h,0px)+1rem)] left-1/2 -translate-x-1/2 z-(--z-focus-chrome) py-2.5 px-[18px] rounded-[10px] bg-bg-elevated/92 backdrop-blur-overlay border border-border-subtle text-caption text-text-secondary shadow-[0_2px_8px_rgba(0,0,0,0.08)]"
			>
				{{ t('builder.focus.hintBefore') }}
				<kbd
					class="inline-block py-0.5 px-[7px] rounded bg-bg-surface text-text-primary font-mono text-2xs font-medium border border-border-subtle shadow-[0_1px_0_rgba(0,0,0,0.06)]"
					>Esc</kbd
				>
				{{ t('builder.focus.hintAfter') }}
			</div>
		</Transition>
	</div>

	<!-- Focus Mode Save Indicator (shows unsaved changes status) -->
	<Transition
		enter-active-class="transition-[opacity,translate] duration-(--motion-moderate) ease-spring"
		leave-active-class="transition-[opacity,translate] duration-(--motion-moderate-exit) ease-exit"
		enter-from-class="opacity-0 -translate-y-2.5"
		leave-to-class="opacity-0 -translate-y-2.5"
	>
		<div
			v-if="isFocusMode"
			class="fixed top-[calc(var(--titlebar-h,0px)+1rem)] left-4 z-(--z-focus-chrome) flex items-center gap-2 py-2 px-3.5 rounded-[10px] bg-bg-elevated/85 backdrop-blur-overlay border border-border-subtle opacity-70 transition-[opacity,box-shadow] duration-(--motion-moderate) hover:opacity-100 hover:shadow-[0_2px_8px_rgba(0,0,0,0.08)]"
		>
			<div
				class="w-2 h-2 rounded-full transition-[background-color] duration-(--motion-fast)"
				:class="isSaving ? 'bg-warning animate-eb-pulse' : 'bg-success'"
				aria-hidden="true"
			/>
			<span class="text-xs text-text-secondary">
				{{ isSaving ? t('builder.focus.saving') : t('builder.focus.saved') }}
			</span>
		</div>
	</Transition>

	<!-- Focus Mode Exit Button (floating overlay) -->
	<Transition
		enter-active-class="transition-[opacity,translate] duration-(--motion-moderate) ease-spring"
		leave-active-class="transition-[opacity,translate] duration-(--motion-moderate-exit) ease-exit"
		enter-from-class="opacity-0 -translate-y-2.5"
		leave-to-class="opacity-0 -translate-y-2.5"
	>
		<UiTooltip v-if="isFocusMode" :text="t('builder.focus.exitTitle')">
			<button
				ref="exitButtonRef"
				class="fixed top-[calc(var(--titlebar-h,0px)+1rem)] right-4 z-(--z-focus-chrome) p-2.5 rounded-[10px] bg-bg-elevated/85 backdrop-blur-overlay border border-border-subtle text-text-secondary cursor-pointer opacity-70 transition-[color,background-color,opacity,scale] duration-(--motion-moderate) hover:opacity-100 focus-visible:opacity-100 hover:text-text-primary hover:bg-bg-elevated/95 hover:scale-105 active:scale-95"
				:aria-label="t('builder.focus.exit')"
				type="button"
				@click="emit('exit')"
			>
				<CloseIcon :size="20" aria-hidden="true" />
			</button>
		</UiTooltip>
	</Transition>
</template>
