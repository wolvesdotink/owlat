<script setup lang="ts">
import { X } from '@lucide/vue';

defineProps<{
	isFocusMode: boolean;
	showHint: boolean;
	isSaving: boolean;
}>();

const emit = defineEmits<{
	(e: 'exit'): void;
}>();
</script>

<template>
	<!-- Focus Mode Keyboard Shortcut Hint (shows briefly when entering focus mode) -->
	<Transition
		enter-active-class="transition-all duration-(--motion-moderate) ease-spring"
		leave-active-class="transition-all duration-(--motion-slow-exit) ease-exit"
		enter-from-class="opacity-0 -translate-y-2.5"
		leave-to-class="opacity-0 -translate-y-[5px]"
	>
		<div
			v-if="showHint"
			class="fixed top-4 left-1/2 -translate-x-1/2 z-[10050] py-2.5 px-[18px] rounded-[10px] bg-bg-elevated/92 backdrop-blur-overlay border border-border-subtle text-[13px] text-text-secondary shadow-[0_2px_8px_rgba(0,0,0,0.08)]"
		>
			Press
			<kbd class="inline-block py-0.5 px-[7px] rounded bg-bg-surface text-text-primary font-mono text-[11px] font-medium border border-border-subtle shadow-[0_1px_0_rgba(0,0,0,0.06)]">Esc</kbd>
			to exit focus mode
		</div>
	</Transition>

	<!-- Focus Mode Save Indicator (shows unsaved changes status) -->
	<Transition
		enter-active-class="transition-all duration-(--motion-moderate) ease-spring"
		leave-active-class="transition-all duration-(--motion-moderate-exit) ease-exit"
		enter-from-class="opacity-0 -translate-y-2.5"
		leave-to-class="opacity-0 -translate-y-2.5"
	>
		<div
			v-if="isFocusMode"
			class="fixed top-4 left-4 z-[10050] flex items-center gap-2 py-2 px-3.5 rounded-[10px] bg-bg-elevated/85 backdrop-blur-overlay border border-border-subtle opacity-50 transition-[opacity,box-shadow] duration-(--motion-moderate) hover:opacity-100 hover:shadow-[0_2px_8px_rgba(0,0,0,0.08)]"
		>
			<div
				class="w-2 h-2 rounded-full bg-green-500 transition-[background-color] duration-(--motion-fast)"
				:class="{ 'bg-amber-500 animate-eb-pulse': isSaving }"
			/>
			<span class="text-xs text-text-secondary">
				{{ isSaving ? 'Saving...' : 'Saved' }}
			</span>
		</div>
	</Transition>

	<!-- Focus Mode Exit Button (floating overlay) -->
	<Transition
		enter-active-class="transition-all duration-(--motion-moderate) ease-spring"
		leave-active-class="transition-all duration-(--motion-moderate-exit) ease-exit"
		enter-from-class="opacity-0 -translate-y-2.5"
		leave-to-class="opacity-0 -translate-y-2.5"
	>
		<button
			v-if="isFocusMode"
			class="fixed top-4 right-4 z-[10050] p-2.5 rounded-[10px] bg-bg-elevated/85 backdrop-blur-overlay border border-border-subtle text-text-secondary cursor-pointer opacity-30 transition-all duration-(--motion-moderate) hover:opacity-100 hover:text-text-primary hover:bg-bg-elevated/95 hover:scale-105 active:scale-95"
			title="Exit focus mode (Esc)"
			@click="emit('exit')"
		>
			<X :size="20" />
		</button>
	</Transition>
</template>
