<script setup lang="ts">
/**
 * Overlay layer for the AI selection-rewrite feature in the Simple composer:
 * the floating pill over an eligible selection, the original-vs-rewritten
 * preview card, and the transient "Rewritten — Undo" affordance.
 *
 * All three fragments are driven by a single {@link usePostboxRewriteController}
 * instance passed in by `PostboxBasicEditor` — this component is pure chrome
 * (placement styles + click wiring) so the editor SFC stays focused on the
 * contenteditable surface. Mounted only when the parent's `ai` flag is on.
 */

import type { usePostboxRewriteController } from '~/composables/postbox/usePostboxRewriteController';

defineProps<{
	controller: ReturnType<typeof usePostboxRewriteController>;
}>();
</script>

<template>
	<!-- AI rewrite pill over the selection (hidden while a preview is showing). -->
	<PostboxRewritePill
		v-if="controller.pillStyle.value"
		:pill-style="controller.pillStyle.value"
		:loading="controller.rewrite.isLoading()"
		:active-intent="controller.rewrite.activeIntent.value"
		:languages="controller.languages"
		@select="controller.onSelect"
	/>
	<!-- Original-vs-rewritten preview; Apply/Discard only, never auto-applied. -->
	<PostboxRewritePreview
		v-if="controller.previewStyle.value"
		:card-style="controller.previewStyle.value"
		:original="controller.rewrite.original.value"
		:rewritten="controller.rewrite.rewritten.value"
		@apply="controller.apply"
		@discard="controller.discard"
	/>
	<!-- Transient "Rewritten — Undo" affordance (native single-step undo). -->
	<div
		v-if="controller.showUndo.value"
		class="absolute bottom-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border-subtle bg-bg-elevated px-3 py-1.5 text-xs shadow-lg"
	>
		<span class="text-text-secondary">Rewritten</span>
		<button
			type="button"
			class="font-medium text-brand hover:underline"
			@mousedown.prevent
			@click="controller.undo"
		>
			Undo
		</button>
	</div>
</template>
