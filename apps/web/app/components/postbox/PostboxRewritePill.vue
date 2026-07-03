<script setup lang="ts">
/**
 * Tiny floating AI rewrite pill shown over a text selection in the Simple
 * composer. Modeled on the email-builder's FloatingToolbar (absolutely
 * positioned near the selection) but deliberately minimal: one-tap tone/grammar
 * rewrites plus a Translate… submenu (via {@link PostboxRewriteActions}).
 *
 * Used STANDALONE only when the classic persistent toolbar is on; in the default
 * floating-toolbar mode the same {@link PostboxRewriteActions} render inside the
 * combined {@link PostboxFloatingFormatBar} instead of a second stacked popover.
 *
 * Advisory only — clicking an option asks the parent to fetch a rewrite and show
 * a preview; nothing is applied here. Position + loading are owned by the parent.
 */

import type { RewriteIntent } from '~/composables/postbox/usePostboxSelectionRewrite';

defineProps<{
	/** Absolute-position style computed from the selection rect by the parent. */
	pillStyle: Record<string, string> | null;
	/** True while a rewrite request is in flight (disables the pill). */
	loading?: boolean;
	/** The intent currently loading, for a per-button spinner. */
	activeIntent?: RewriteIntent | null;
	/** Recent + default translate targets. */
	languages: string[];
}>();

const emit = defineEmits<{
	(e: 'select', payload: { intent: RewriteIntent; targetLanguage?: string }): void;
}>();
</script>

<template>
	<div
		v-if="pillStyle"
		class="postbox-rewrite-pill absolute z-30 flex items-center gap-0.5 rounded-lg border border-border-subtle bg-bg-elevated px-1 py-1 shadow-lg"
		:style="pillStyle"
		role="toolbar"
		aria-label="Rewrite selection with AI"
		@mousedown.prevent
	>
		<PostboxRewriteActions
			:loading="loading"
			:active-intent="activeIntent"
			:languages="languages"
			@select="emit('select', $event)"
		/>
	</div>
</template>
