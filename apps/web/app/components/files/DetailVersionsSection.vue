<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import type { useFileVersionHistory } from '~/composables/useFileVersionHistory';

/**
 * The file detail page's collapsible version history. The page owns the
 * history subscription so it starts alongside the file read rather than after it.
 */
defineProps<{
	history: ReturnType<typeof useFileVersionHistory>;
	currentVersionId: Id<'semanticFiles'>;
}>();

const { t } = useI18n();

const showVersions = ref(true);
</script>

<template>
	<div class="bg-bg-elevated shadow-surface-1 rounded-(--radius-card)">
		<button
			class="w-full flex items-center justify-between px-5 py-4"
			@click="showVersions = !showVersions"
		>
			<div class="flex items-center gap-2">
				<Icon name="lucide:history" class="w-4 h-4 text-text-tertiary" />
				<span class="text-sm font-medium text-text-primary">{{
					t('dashboard.files.detail.versionHistory')
				}}</span>
				<span v-if="history.versions.value" class="text-xs text-text-tertiary"
					>({{ history.versions.value.length }}{{ history.isIncomplete.value ? '+' : '' }})</span
				>
			</div>
			<Icon
				name="lucide:chevron-down"
				class="w-4 h-4 text-text-tertiary transition-transform"
				:class="{ '-rotate-180': showVersions }"
			/>
		</button>
		<div v-if="showVersions" class="px-5 pb-4">
			<FilesVersionHistory
				:versions="history.versions.value || []"
				:current-version-id="currentVersionId"
				:has-older="history.hasOlder.value"
				:older-unavailable="history.olderUnavailable.value"
				:loading-older="history.isLoadingOlder.value"
				:load-older-failed="history.loadOlderFailed.value"
				:history-restarted="history.historyRestarted.value"
				@load-older="history.loadOlder"
			/>
		</div>
	</div>
</template>
