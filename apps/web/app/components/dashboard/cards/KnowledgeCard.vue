<script setup lang="ts">
import { api } from '@owlat/api';
import { entryTypeLabel, entryTypeVariant } from '~/utils/knowledgeEntryTypes';

const { t } = useI18n();

const { data: entries, isLoading } = useOrganizationQuery(api.knowledge.graph.listByType, {
	entryType: 'fact',
	limit: 5,
});

interface KnowledgeEntry {
	_id: string;
	entryType: string;
	title: string;
	content: string;
	_creationTime: number;
}

const entryList = computed<KnowledgeEntry[]>(() => {
	return (entries.value as KnowledgeEntry[] | null) ?? [];
});

function truncateContent(content: string, maxLength = 80): string {
	if (content.length <= maxLength) return content;
	return content.slice(0, maxLength).trimEnd() + '...';
}
</script>

<template>
	<UiCard class="h-full" padding="none" overflow="hidden">
		<div class="p-5">
			<div class="flex items-center justify-between mb-4">
				<div class="flex items-center gap-2.5">
					<UiIconBox icon="lucide:brain" size="sm" variant="surface" />
					<h3 class="text-sm font-semibold text-text-primary">
						{{ t('components.dashboard.cards.knowledge.title') }}
					</h3>
				</div>
			</div>

			<DashboardCardSkeleton v-if="isLoading" shape="list" :count="3" :avatar="false" />

			<div v-else-if="entryList.length === 0" class="py-4 text-center">
				<p class="text-sm text-text-tertiary">
					{{ t('components.dashboard.cards.knowledge.empty') }}
				</p>
			</div>

			<div v-else class="space-y-2">
				<div
					v-for="entry in entryList"
					:key="entry._id"
					class="rounded-lg bg-bg-surface px-3 py-2.5"
				>
					<div class="flex items-center gap-2 mb-1">
						<UiBadge :variant="entryTypeVariant(entry.entryType)" size="sm">
							{{ t(entryTypeLabel(entry.entryType)) }}
						</UiBadge>
						<span class="text-xs font-medium text-text-primary truncate">{{ entry.title }}</span>
					</div>
					<p class="text-xs text-text-tertiary leading-relaxed">
						{{ truncateContent(entry.content) }}
					</p>
				</div>
			</div>
		</div>
	</UiCard>
</template>
