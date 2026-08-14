<script setup lang="ts">
/**
 * Composer footer controls: the "Aa" formatting-toolbar toggle (simple mode
 * only — flips between the minimal floating bar and the classic persistent
 * toolbar) and an optional path into the layout designer. Split out of
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

const { t } = useI18n();
</script>

<template>
	<div class="inline-flex items-center gap-1">
		<UiButton
			variant="ghost"
			v-if="mode === 'simple'"
			type="button"
			:class="{ 'text-brand': persistentToolbar }"
			:aria-pressed="persistentToolbar"
			:title="
				persistentToolbar
					? t('components.postbox.postboxComposerModeControls.hideToolbar')
					: t('components.postbox.postboxComposerModeControls.showToolbar')
			"
			@click="emit('toggle-toolbar')"
		>
			<Icon name="lucide:type" class="w-4 h-4" />
		</UiButton>
		<UiButton
			variant="ghost"
			type="button"
			class="text-xs"
			@click="emit('switch-mode', mode === 'simple' ? 'full' : 'simple')"
		>
			<Icon
				:name="mode === 'simple' ? 'lucide:layout-template' : 'lucide:pen-line'"
				class="w-4 h-4"
			/>
			{{
				mode === 'simple'
					? t('components.postbox.postboxComposerModeControls.designLayout')
					: t('components.postbox.postboxComposerModeControls.returnToWriting')
			}}
		</UiButton>
	</div>
</template>
