<script setup lang="ts">
/**
 * Popup composer title bar: the draft's subject (or "New message" until one is
 * typed) and the window controls. A reply also offers "Open in Answer mode",
 * which the parent answers by saving the draft and moving it there (plan §02:
 * the popup's maximise button opens a reply in Answer mode). Compose-new stays
 * a popup, so it has no such control. The parent owns the dock and the route,
 * so this header only emits.
 */

defineProps<{
	/** Draft subject; empty until the author types one. */
	subject: string;
	/** A reply: offer "Open in Answer mode". */
	canMaximise?: boolean;
	/** The move to Answer mode is in flight (the autosave is being flushed). */
	maximising?: boolean;
}>();

const emit = defineEmits<{
	/** Reply only: continue this draft in Answer mode. */
	maximise: [];
	/** Collapse to the composer dock. */
	minimize: [];
	/** Throw the draft away. */
	discard: [];
}>();

const { t } = useI18n();
</script>

<template>
	<header
		class="flex items-center justify-between px-3 py-2 bg-bg-surface border-b border-border-subtle"
	>
		<span class="text-sm font-semibold">
			{{ subject || t('components.postbox.postboxComposer.newMessage') }}
		</span>
		<div class="flex items-center gap-1">
			<button
				v-if="canMaximise"
				type="button"
				class="p-1 hover:bg-bg-elevated rounded"
				:title="t('components.postbox.postboxComposer.openInAnswerMode')"
				:aria-label="t('components.postbox.postboxComposer.openInAnswerMode')"
				:disabled="maximising"
				data-testid="composer-maximise"
				@click="emit('maximise')"
			>
				<Icon name="lucide:maximize-2" class="w-4 h-4" />
			</button>
			<button
				type="button"
				class="p-1 hover:bg-bg-elevated rounded"
				:title="t('components.postbox.postboxComposer.minimize')"
				@click="emit('minimize')"
			>
				<Icon name="lucide:minus" class="w-4 h-4" />
			</button>
			<button
				type="button"
				class="p-1 hover:bg-bg-elevated rounded"
				:title="t('common.discard')"
				@click="emit('discard')"
			>
				<Icon name="lucide:x" class="w-4 h-4" />
			</button>
		</div>
	</header>
</template>
