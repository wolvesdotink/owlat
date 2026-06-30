<script setup lang="ts">
/**
 * Shared shell for the chat dialogs (new channel / new DM / link email /
 * channel browser) — overlay, panel, header, close button. The four dialogs
 * carried byte-identical copies of this markup before. Body goes in the
 * default slot; Escape and overlay-click both close.
 */
defineProps<{
	title: string;
	/** Panel width: 'md' for forms, 'lg' for scrollable browsers. */
	size?: 'md' | 'lg';
}>();

const emit = defineEmits<{ close: [] }>();

const panelRef = ref<HTMLElement | null>(null);
// Focus trap + opener restore + Escape, shared with UiModal.
useModalFocus(panelRef, () => true, () => emit('close'));
</script>

<template>
	<Teleport to="body">
		<div
			class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
			@click.self="emit('close')"
		>
			<div
				ref="panelRef"
				role="dialog"
				aria-modal="true"
				tabindex="-1"
				:class="[
					'w-full bg-bg-elevated border border-border-subtle rounded-xl shadow-xl',
					size === 'lg' ? 'max-w-lg flex flex-col max-h-[80vh]' : 'max-w-md',
				]"
			>
				<div class="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
					<h3 class="text-base font-semibold text-text-primary">{{ title }}</h3>
					<button
						class="w-8 h-8 rounded-lg flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-bg-surface transition-colors"
						@click="emit('close')"
					 aria-label="Close">
						<Icon name="lucide:x" class="w-4 h-4" />
					</button>
				</div>

				<slot />
			</div>
		</div>
	</Teleport>
</template>
