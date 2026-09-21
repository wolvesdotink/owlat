<script setup lang="ts">
/**
 * The compose FAB — the touch entry point for writing, below `lg` only.
 *
 * At that width the folder rail (and the Compose button that lives in it) is an
 * off-canvas drawer, so without this there is no way to start a message without
 * opening a navigation drawer first. It hides while a message is open: the
 * reader carries its own reply affordances, and the FAB would sit on top of
 * them. Same entry point as the rail's button — the composer stack.
 */
import type { Id } from '@owlat/api/dataModel';

const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	/** A message is open: the reader owns the corner. */
	hidden?: boolean;
}>();

const { t } = useI18n();
const composerStack = usePostboxComposerStack();
</script>

<template>
	<button
		v-if="!props.hidden"
		type="button"
		class="lg:hidden fixed bottom-5 right-5 z-30 w-13 h-13 rounded-full bg-brand text-text-inverse shadow-lg flex items-center justify-center hover:bg-brand-hover transition-colors duration-(--motion-fast) focus-visible:ring-2 focus-visible:ring-brand/50 outline-none"
		:aria-label="t('components.postbox.postboxComposeButton.compose')"
		@click="composerStack.open({ mailboxId })"
	>
		<Icon name="lucide:pen-line" class="w-5 h-5" />
	</button>
</template>
