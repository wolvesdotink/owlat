<script setup lang="ts">
/**
 * Floating format bar for {@link PostboxBasicEditor}. In the default (minimal)
 * mode the persistent toolbar is hidden and this bar appears above the current
 * text selection instead — Apple-Mail style. Positioning (viewport-clamped,
 * flips below near the top, hides on scroll/blur/collapse) is owned by the
 * editor; this component is pure chrome.
 *
 * When the AI selection-rewrite pill would ALSO show for the same selection, the
 * editor sets `showAiActions` so the two render as ONE combined bar (format
 * commands left, AI actions right) rather than two stacked popovers.
 *
 * `@mousedown.prevent` on the container keeps clicks from stealing the selection
 * out of the contenteditable.
 */

import type { ActiveMarks } from '@owlat/ui/composables/useRichText';
import type { RewriteIntent } from '~/composables/postbox/usePostboxSelectionRewrite';

defineProps<{
	/** Absolute-position style computed from the selection rect by the editor. */
	barStyle: Record<string, string> | null;
	activeMarks: ActiveMarks;
	/** Render the AI rewrite actions on the right (combined bar). */
	showAiActions?: boolean;
	/** True while a rewrite request is in flight (disables the AI buttons). */
	aiLoading?: boolean;
	/** The rewrite intent currently loading, for a per-button spinner. */
	aiActiveIntent?: RewriteIntent | null;
	/** Recent + default translate targets for the AI actions. */
	aiLanguages?: string[];
}>();

const emit = defineEmits<{
	(e: 'bold'): void;
	(e: 'italic'): void;
	(e: 'underline'): void;
	(e: 'heading', level: 1 | 2): void;
	(e: 'list', ordered: boolean): void;
	(e: 'blockquote'): void;
	(e: 'link'): void;
	(e: 'ai-select', payload: { intent: RewriteIntent; targetLanguage?: string }): void;
}>();
</script>

<template>
	<div
		v-if="barStyle"
		class="postbox-floating-format-bar absolute z-30 flex items-center gap-0.5 rounded-lg border border-border-subtle bg-bg-elevated px-1 py-1 shadow-lg"
		:style="barStyle"
		role="toolbar"
		aria-label="Format selection"
		data-testid="postbox-floating-format-bar"
		@mousedown.prevent
	>
		<PostboxEditorToolbar
			variant="floating"
			:active-marks="activeMarks"
			@bold="emit('bold')"
			@italic="emit('italic')"
			@underline="emit('underline')"
			@heading="(level) => emit('heading', level)"
			@list="(ordered) => emit('list', ordered)"
			@blockquote="emit('blockquote')"
			@link="emit('link')"
		/>
		<template v-if="showAiActions">
			<span class="w-px h-4 bg-border-subtle mx-1" />
			<PostboxRewriteActions
				:loading="aiLoading"
				:active-intent="aiActiveIntent"
				:languages="aiLanguages ?? []"
				@select="emit('ai-select', $event)"
			/>
		</template>
	</div>
</template>
