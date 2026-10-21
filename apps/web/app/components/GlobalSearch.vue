<script setup lang="ts">
import { useShortcutLabels } from '~/composables/useShortcutLabels';

/**
 * Header search entry point. The search + command experience itself lives in the
 * app-wide `AppCommandPalette` (Cmd/Ctrl-K, mounted once in the dashboard
 * layout); this button just opens it via the shared `useCommandPalette` control
 * (web only — desktop uses the titlebar pill instead).
 */
const { t } = useI18n();
const { open: openSearch } = useCommandPalette();
const { ariaFor } = useShortcutLabels();
</script>

<template>
	<button
		class="flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:text-text-primary bg-bg-surface hover:bg-bg-surface-hover border border-border-subtle rounded-lg transition-colors duration-(--motion-fast)"
		:aria-keyshortcuts="ariaFor('global.commandPalette')"
		@click="() => openSearch()"
	>
		<Icon name="lucide:search" class="w-4 h-4" />
		<span class="hidden sm:inline">{{ t('components.globalSearch.search') }}</span>
		<UiShortcut
			id="global.commandPalette"
			class="hidden sm:inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium text-text-tertiary bg-bg-elevated border border-border-subtle rounded"
		/>
	</button>
</template>
