<script setup lang="ts">
/**
 * The frame every composer renders in, whatever it writes to (#812): the
 * mailbox composer (`PostboxComposer`) and the Team inbox reply
 * (`InboxThreadComposer`). Top to bottom: an optional header, the
 * envelope, one scroll region holding everything between the envelope and the
 * footer (the strips keep their height, the body keeps at least 6rem), and the
 * footer, pinned outside it so Send never scrolls away.
 *
 * The composer target decides what the frame offers. The footer slot receives
 * the target's capabilities (`utils/composerTarget`) for the shared footer to
 * read, and file drops only show their overlay where the composer uploads its
 * own attachments. Layout only: the state, the editor and the send belong to
 * the host. Drag, paste and key listeners fall through to the root element.
 */
import { composerTargetCapabilities, type ComposerTarget } from '~/utils/composerTarget';

const props = defineProps<{
	target: ComposerTarget;
	/** Files are being dragged over the composer. */
	dragActive?: boolean;
}>();

const { t } = useI18n();

const capabilities = computed(() => composerTargetCapabilities(props.target));
</script>

<template>
	<div class="relative flex flex-col h-full bg-bg-elevated" :data-composer-target="target.kind">
		<div
			v-if="dragActive && capabilities.attachments === 'draft'"
			class="absolute inset-0 z-10 flex items-center justify-center bg-brand/10 border-2 border-dashed border-brand rounded pointer-events-none"
		>
			<span class="text-sm font-medium text-brand">
				{{ t('components.postbox.postboxComposer.dropHint') }}
			</span>
		</div>
		<slot name="header" />
		<slot name="envelope" />
		<div class="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="composer-scroll">
			<slot />
		</div>
		<slot name="footer" :capabilities="capabilities" />
	</div>
</template>
