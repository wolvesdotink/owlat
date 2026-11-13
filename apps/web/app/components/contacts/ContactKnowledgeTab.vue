<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { entryTypeIcon, entryTypeLabel, entryTypeVariant } from '~/utils/knowledgeEntryTypes';
import { BrainIcon } from '@coolicons/vue';

const props = defineProps<{
	contactId: Id<'contacts'>;
}>();

const { t } = useI18n();

const ENTRY_LIMIT = 50;
const {
	data: entries,
	isLoading,
	error,
	refetch,
} = useConvexQuery(api.knowledge.graph.getByContact, () => ({
	contactId: props.contactId,
	limit: ENTRY_LIMIT,
}));

const typeVariant = entryTypeVariant;
const typeIcon = entryTypeIcon;
const typeLabel = entryTypeLabel;

const truncate = (text: string, max = 100): string => {
	return text.length > max ? text.slice(0, max) + '…' : text;
};
</script>

<template>
	<div class="card">
		<div class="flex items-center justify-between mb-4">
			<h2 class="text-lg font-medium text-text-primary">
				{{ t('components.contacts.contactKnowledgeTab.title') }}
			</h2>
			<span v-if="entries" class="text-xs text-text-tertiary">
				{{
					t(
						'components.contacts.contactKnowledgeTab.count',
						{ count: entries.length },
						entries.length
					)
				}}
			</span>
		</div>

		<!-- A failed read is not an empty list. -->
		<UiQueryBoundary v-if="error" :error="error" @retry="refetch" />

		<!-- Loading -->
		<div v-else-if="isLoading" class="flex items-center justify-center py-8">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner size="md" />
				<p class="text-text-tertiary text-sm">
					{{ t('components.contacts.contactKnowledgeTab.loading') }}
				</p>
			</div>
		</div>

		<!-- Empty -->
		<div
			v-else-if="!entries || entries.length === 0"
			class="flex flex-col items-center justify-center py-8 text-center"
		>
			<UiIconBox :icon="BrainIcon" size="lg" variant="surface" rounded="full" class="mb-3" />
			<p class="text-text-secondary text-sm">
				{{ t('components.contacts.contactKnowledgeTab.emptyTitle') }}
			</p>
			<p class="text-text-tertiary text-sm mt-1">
				{{ t('components.contacts.contactKnowledgeTab.emptyBody') }}
			</p>
		</div>

		<!-- Entry list -->
		<div v-else class="space-y-3">
			<NuxtLink
				v-for="entry in entries"
				:key="entry._id"
				:to="`/dashboard/knowledge/${entry._id}`"
				class="block p-3 rounded-lg bg-bg-surface hover:bg-bg-surface-hover border border-border-subtle hover:border-brand/30 transition-colors"
			>
				<div class="flex items-start gap-3">
					<!-- Type icon -->
					<div class="flex-shrink-0 p-1.5 rounded-lg bg-bg-elevated">
						<component :is="typeIcon(entry.entryType)" class="w-4 h-4 text-text-tertiary" />
					</div>

					<div class="flex-1 min-w-0">
						<!-- Header -->
						<div class="flex items-center gap-2 mb-1">
							<UiBadge :variant="typeVariant(entry.entryType)" size="sm">
								{{ typeLabel(entry.entryType) }}
							</UiBadge>
						</div>

						<!-- Title -->
						<p class="text-sm font-medium text-text-primary">{{ entry.title }}</p>

						<!-- Content preview -->
						<p class="text-xs text-text-secondary mt-0.5">
							{{ truncate(entry.content) }}
						</p>

						<!-- Tags + Date -->
						<div class="flex items-center gap-2 mt-2">
							<span
								v-for="tag in (entry.tags || []).slice(0, 3)"
								:key="tag"
								class="inline-block px-1.5 py-0.5 rounded text-2xs bg-bg-elevated text-text-tertiary"
							>
								{{ tag }}
							</span>
							<span class="text-2xs text-text-tertiary ml-auto">
								{{ formatDate(entry.createdAt) }}
							</span>
						</div>
					</div>
				</div>
			</NuxtLink>
			<!-- The read stops at the limit; say so rather than imply that is all. -->
			<p v-if="entries.length >= ENTRY_LIMIT" class="text-xs text-text-tertiary">
				{{ t('components.contacts.contactKnowledgeTab.limitNote', { count: ENTRY_LIMIT }) }}
			</p>
		</div>
	</div>
</template>
