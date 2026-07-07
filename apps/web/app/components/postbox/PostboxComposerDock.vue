<script setup lang="ts">
/**
 * Bottom dock of minimized / overflow composers. A tidy left-anchored flex row
 * of chips (subject + a small unsaved-draft dot) that never marches offscreen by
 * pixel offset and never overlaps the reader's action bar (it clears the shared
 * `--pbx-composer-inset-bottom`). Clicking a chip brings that composer back to a
 * floating popup.
 */
import type { ComposerSpec } from '~/composables/postbox/usePostboxComposerStack';

defineProps<{
	composers: ComposerSpec[];
}>();

const stack = usePostboxComposerStack();
</script>

<template>
	<div
		v-if="composers.length > 0"
		class="fixed left-6 z-40 flex items-end gap-2"
		style="bottom: var(--pbx-composer-inset-bottom, 0px)"
	>
		<TransitionGroup name="pbx-popup">
			<button
				v-for="composer in composers"
				:key="composer.id"
				type="button"
				class="h-9 px-3 bg-bg-elevated border border-border-subtle rounded-t-md shadow-lg flex items-center gap-2 text-sm text-text-primary hover:bg-bg-surface transition-colors"
				:title="`Reopen: ${composer.prefillSubject || 'Draft'}`"
				@click="stack.bringToFront(composer.id)"
			>
				<span class="w-1.5 h-1.5 rounded-full bg-accent shrink-0" aria-hidden="true" />
				<Icon name="lucide:mail" class="w-4 h-4 text-text-secondary" />
				<span class="truncate max-w-[160px]">
					{{ composer.prefillSubject || 'Draft' }}
				</span>
			</button>
		</TransitionGroup>
	</div>
</template>
