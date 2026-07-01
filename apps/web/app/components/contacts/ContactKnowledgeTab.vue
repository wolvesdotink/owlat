<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { entryTypeIcon, entryTypeLabel, entryTypeVariant } from '~/utils/knowledgeEntryTypes';

const props = defineProps<{
	contactId: Id<'contacts'>;
}>();

const { data: entries, isLoading } = useConvexQuery(
	api.knowledge.graph.getByContact,
	() => ({ contactId: props.contactId, limit: 50 }),
);

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
			<h2 class="text-lg font-medium text-text-primary">Knowledge</h2>
			<span v-if="entries" class="text-xs text-text-tertiary">
				{{ entries.length }} {{ entries.length === 1 ? 'entry' : 'entries' }}
			</span>
		</div>

		<!-- Loading -->
		<div v-if="isLoading" class="flex items-center justify-center py-8">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner size="md" />
				<p class="text-text-tertiary text-sm">Loading knowledge...</p>
			</div>
		</div>

		<!-- Empty -->
		<div
			v-else-if="!entries || entries.length === 0"
			class="flex flex-col items-center justify-center py-8 text-center"
		>
			<UiIconBox icon="lucide:brain" size="lg" variant="surface" rounded="full" class="mb-3" />
			<p class="text-text-secondary text-sm">No knowledge entries yet</p>
			<p class="text-text-tertiary text-sm mt-1">
				Knowledge is automatically extracted from conversations with this contact.
			</p>
		</div>

		<!-- Entry list -->
		<div v-else class="space-y-3">
			<NuxtLink
				v-for="entry in entries"
				:key="entry._id"
				:to="`/dashboard/knowledge/${entry._id}`"
				class="block p-3 rounded-lg bg-bg-surface hover:bg-bg-surface/80 border border-border-subtle hover:border-brand/30 transition-colors"
			>
				<div class="flex items-start gap-3">
					<!-- Type icon -->
					<div class="flex-shrink-0 p-1.5 rounded-lg bg-bg-elevated">
						<Icon :name="typeIcon(entry.entryType)" class="w-4 h-4 text-text-tertiary" />
					</div>

					<div class="flex-1 min-w-0">
						<!-- Header -->
						<div class="flex items-center gap-2 mb-1">
							<UiBadge :variant="typeVariant(entry.entryType)" size="sm">
								{{ typeLabel(entry.entryType) }}
							</UiBadge>
							<span class="text-xs text-text-tertiary">
								{{ Math.round(entry.confidence * 100) }}% confidence
							</span>
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
								class="inline-block px-1.5 py-0.5 rounded text-[10px] bg-bg-elevated text-text-tertiary"
							>
								{{ tag }}
							</span>
							<span class="text-[10px] text-text-tertiary ml-auto">
								{{ formatDate(entry.createdAt) }}
							</span>
						</div>
					</div>
				</div>
			</NuxtLink>
		</div>
	</div>
</template>
