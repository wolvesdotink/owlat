<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import type { useFileVersionHistory } from '~/composables/useFileVersionHistory';
import { ChevronDownIcon, HistoryIcon } from '@coolicons/vue';

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
const panelId = useId();
</script>

<template>
	<div class="bg-surface-2 shadow-surface-1 rounded-(--radius-card)">
		<button
			type="button"
			class="w-full flex items-center justify-between px-5 py-4 rounded-(--radius-card) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
			:aria-expanded="showVersions"
			:aria-controls="panelId"
			@click="showVersions = !showVersions"
		>
			<div class="flex items-center gap-2">
				<HistoryIcon class="w-4 h-4 text-text-tertiary" aria-hidden="true" />
				<span class="text-sm font-medium text-text-primary">{{
					t('dashboard.files.detail.versionHistory')
				}}</span>
				<span v-if="history.versions.value" class="text-xs text-text-tertiary"
					>({{ history.versions.value.length }}{{ history.isIncomplete.value ? '+' : '' }})</span
				>
			</div>
			<ChevronDownIcon
				class="w-4 h-4 text-text-tertiary transition-transform"
				:class="{ '-rotate-180': showVersions }"
				aria-hidden="true"
			/>
		</button>
		<div v-if="showVersions" :id="panelId" class="px-5 pb-4">
			<!-- The first page has not landed yet: not the same as "no versions". -->
			<div v-if="history.versions.value === undefined" aria-busy="true">
				<p role="status" class="sr-only">{{ t('common.loading') }}</p>
				<div class="space-y-2" aria-hidden="true">
					<UiSkeleton v-for="row in 2" :key="row" class="h-10 w-full" />
				</div>
			</div>
			<FilesVersionHistory
				v-else
				:versions="history.versions.value"
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
