<script setup lang="ts">
/**
 * Composer footer controls: the "Aa" formatting-toolbar toggle (simple mode
 * only — flips between the minimal floating bar and the classic persistent
 * toolbar) and the Simple / Designer editor-mode segmented control. Split out of
 * PostboxComposer.vue to keep that orchestrator under the file-size ratchet.
 */
import type { ComposerMode } from '~/composables/postbox/usePostboxCompose';

defineProps<{
	mode: ComposerMode;
	/** Whether the classic persistent toolbar is active (drives the "Aa" state). */
	persistentToolbar: boolean;
}>();

const emit = defineEmits<{
	(e: 'toggle-toolbar'): void;
	(e: 'switch-mode', mode: ComposerMode): void;
}>();
</script>

<template>
	<div class="inline-flex items-center gap-1">
		<button
			v-if="mode === 'simple'"
			type="button"
			class="btn btn-ghost"
			:class="{ 'text-brand': persistentToolbar }"
			:aria-pressed="persistentToolbar"
			:title="persistentToolbar ? 'Hide formatting toolbar (show on selection)' : 'Show formatting toolbar'"
			@click="emit('toggle-toolbar')"
		>
			<Icon name="lucide:type" class="w-4 h-4" />
		</button>
		<div
			class="inline-flex items-center gap-0.5 bg-bg-surface rounded text-xs border border-border-subtle"
		>
			<button
				type="button"
				class="px-2 py-1 rounded"
				:class="mode === 'simple' ? 'bg-bg-elevated text-brand font-medium' : 'text-text-secondary hover:text-text-primary'"
				title="Basic blocks only (text, image, button, divider, list)"
				@click="emit('switch-mode', 'simple')"
			>
				Simple
			</button>
			<button
				type="button"
				class="px-2 py-1 rounded"
				:class="mode === 'full' ? 'bg-bg-elevated text-brand font-medium' : 'text-text-secondary hover:text-text-primary'"
				title="All blocks (heroes, columns, tables, …)"
				@click="emit('switch-mode', 'full')"
			>
				Designer
			</button>
		</div>
	</div>
</template>
