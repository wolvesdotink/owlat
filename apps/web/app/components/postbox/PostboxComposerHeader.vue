<script setup lang="ts">
/**
 * Composer title bar — the draft's subject (or "New message" until one is
 * typed) plus the two window controls every composer surface carries.
 *
 * The left control is variant-dependent and the reason this is a component
 * rather than inline markup: the popup composer minimizes to the dock, while
 * the reader's INLINE reply box has nowhere to minimize to and instead offers
 * "open in popup", which the parent answers by promoting the live draft. Both
 * are requests — the parent owns the dock and the composer stack — so this
 * header only emits.
 */

defineProps<{
	/** Draft subject; empty until the author types one. */
	subject: string;
	/** Compact in-place variant (the reader's inline reply box). */
	inline?: boolean;
	/** A promote is in flight (the debounced autosave is being flushed). */
	promoting?: boolean;
}>();

const emit = defineEmits<{
	/** Inline variant only: expand this draft into a popup composer. */
	promote: [];
	/** Popup variant only: collapse to the composer dock. */
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
				v-if="inline"
				type="button"
				class="p-1 hover:bg-bg-elevated rounded"
				:title="t('components.postbox.postboxComposer.openInPopup')"
				:aria-label="t('components.postbox.postboxComposer.openInPopup')"
				:disabled="promoting"
				@click="emit('promote')"
			>
				<Icon name="lucide:maximize-2" class="w-4 h-4" />
			</button>
			<button
				v-else
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
