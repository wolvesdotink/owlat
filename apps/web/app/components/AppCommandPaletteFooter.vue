<script setup lang="ts">
/**
 * The command palette's key legend.
 *
 * Its own component because the overlay grew a fourth thing to teach — Tab now
 * cycles the SCOPE — and because a strip of `<kbd>` hints is the one part of the
 * palette with no state, no events and no accessibility surface of its own.
 */

defineProps<{
	/** Inside an item's argument step Esc means "back", and scope/mode are inert. */
	pendingArgument: boolean;
}>();

const { t } = useI18n();
</script>

<template>
	<div
		class="px-4 py-2 border-t border-border-subtle bg-bg-surface text-xs text-text-tertiary flex items-center gap-4"
	>
		<span class="flex items-center gap-1">
			<kbd class="px-1 py-0.5 bg-bg-elevated border border-border-subtle rounded text-2xs">↑↓</kbd>
			{{ t('components.appCommandPalette.navigate') }}
		</span>
		<span class="flex items-center gap-1">
			<kbd class="px-1 py-0.5 bg-bg-elevated border border-border-subtle rounded text-2xs">↵</kbd>
			{{ t('components.appCommandPalette.select') }}
		</span>
		<span v-if="!pendingArgument" class="flex items-center gap-1">
			<kbd class="px-1 py-0.5 bg-bg-elevated border border-border-subtle rounded text-2xs">tab</kbd>
			{{ t('components.appCommandPalette.scopeHint') }}
		</span>
		<span class="flex items-center gap-1">
			<kbd class="px-1 py-0.5 bg-bg-elevated border border-border-subtle rounded text-2xs">esc</kbd>
			{{ pendingArgument ? t('components.appCommandPalette.back') : t('common.close') }}
		</span>
		<span v-if="!pendingArgument" class="hidden sm:flex items-center gap-1">
			<kbd class="px-1 py-0.5 bg-bg-elevated border border-border-subtle rounded text-2xs"
				>&gt; @ # ?</kbd
			>
			{{ t('components.appCommandPalette.modeHint') }}
		</span>
	</div>
</template>
