<script setup lang="ts">
/**
 * Compact original-vs-rewritten preview card anchored to the selection after the
 * user picks a rewrite from {@link PostboxRewritePill}. The rewritten text is
 * emphasized; Apply replaces the selection through the editor (undo-able as one
 * step), Discard leaves the selection untouched. Nothing is ever auto-applied.
 */

defineProps<{
	/** Absolute-position style computed from the selection rect by the parent. */
	cardStyle: Record<string, string> | null;
	/** The selected text as it stands now. */
	original: string;
	/** The AI-rewritten replacement. */
	rewritten: string;
}>();

const emit = defineEmits<{
	(e: 'apply'): void;
	(e: 'discard'): void;
}>();
</script>

<template>
	<div
		v-if="cardStyle"
		class="postbox-rewrite-preview absolute z-30 w-72 max-w-[90vw] rounded-lg border border-border-subtle bg-bg-elevated p-2.5 shadow-xl"
		:style="cardStyle"
		role="dialog"
		aria-label="Rewrite preview"
		@mousedown.prevent
	>
		<p class="mb-1 text-[11px] font-medium uppercase tracking-wide text-text-tertiary">
			Original
		</p>
		<p class="mb-2 max-h-20 overflow-auto text-xs text-text-tertiary line-through decoration-1">
			{{ original }}
		</p>
		<p class="mb-1 text-[11px] font-medium uppercase tracking-wide text-brand">
			Rewritten
		</p>
		<p class="mb-2.5 max-h-32 overflow-auto text-sm text-text-primary">
			{{ rewritten }}
		</p>
		<div class="flex items-center justify-end gap-2">
			<button
				type="button"
				class="rounded px-2 py-1 text-xs text-text-secondary hover:bg-bg-surface"
				@click="emit('discard')"
			>
				Discard
			</button>
			<button
				type="button"
				class="inline-flex items-center gap-1 rounded bg-brand px-2.5 py-1 text-xs font-medium text-white hover:opacity-90"
				@click="emit('apply')"
			>
				<Icon name="lucide:check" class="h-3.5 w-3.5" />
				Apply
			</button>
		</div>
	</div>
</template>
