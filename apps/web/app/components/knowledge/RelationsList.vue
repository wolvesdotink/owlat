<script setup lang="ts">
import { relationLabel, relationBadgeClass } from '~/utils/knowledgeEntryTypes';

type Relation = {
	_id: string;
	relationType: string;
	fromEntryId: string;
	toEntryId: string;
};

withDefaults(
	defineProps<{
		outgoingRelations: Relation[];
		incomingRelations: Relation[];
		/** Resolved entry map: entryId → { title, entryType } */
		entryMap?: Record<string, { title: string; entryType: string }>;
		/**
		 * Hide the per-relation remove buttons. Set by read-only consumers (the
		 * graph dashboard's click-through panel), where editing happens on the full
		 * entry detail page instead. Defaults off so the detail page keeps its
		 * remove affordance.
		 */
		readonly?: boolean;
	}>(),
	{ readonly: false },
);

const emit = defineEmits<{
	remove: [relationId: string];
}>();

const { typeVariant, typeLabel } = useKnowledgeGraph();
</script>

<template>
	<div class="space-y-6">
		<!-- Outgoing Relations -->
		<div>
			<h4 class="text-sm font-medium text-text-secondary mb-3 flex items-center gap-2">
				<Icon name="lucide:arrow-right" class="w-4 h-4" />
				Outgoing Relations
				<span class="text-text-tertiary font-normal">({{ outgoingRelations.length }})</span>
			</h4>

			<div v-if="outgoingRelations.length === 0" class="text-sm text-text-tertiary py-3 pl-6">
				No outgoing relations.
			</div>

			<div v-else class="space-y-2">
				<div
					v-for="rel in outgoingRelations"
					:key="`out-${rel._id}`"
					class="flex items-center gap-3 py-2 px-3 rounded-lg bg-bg-surface group"
				>
					<Icon name="lucide:arrow-right" class="w-3.5 h-3.5 text-text-tertiary flex-shrink-0" />

					<span
						class="text-xs font-medium px-2 py-0.5 rounded-full flex-shrink-0"
						:class="relationBadgeClass(rel.relationType)"
					>
						{{ relationLabel(rel.relationType) }}
					</span>

					<NuxtLink
						:to="`/dashboard/knowledge/${rel.toEntryId}`"
						class="text-sm text-text-primary hover:text-brand transition-colors truncate"
					>
						{{ entryMap?.[rel.toEntryId]?.title ?? rel.toEntryId }}
					</NuxtLink>

					<span
						v-if="entryMap?.[rel.toEntryId]?.entryType"
						class="text-[10px] font-medium px-1.5 py-0.5 rounded-full uppercase tracking-wide flex-shrink-0 ml-auto"
						:class="{
							'bg-brand-subtle text-brand': typeVariant(entryMap?.[rel.toEntryId]?.entryType ?? '') === 'default',
							'bg-warning/10 text-warning': typeVariant(entryMap?.[rel.toEntryId]?.entryType ?? '') === 'warning',
							'bg-bg-surface text-text-tertiary': typeVariant(entryMap?.[rel.toEntryId]?.entryType ?? '') === 'neutral',
							'bg-success-subtle text-success': typeVariant(entryMap?.[rel.toEntryId]?.entryType ?? '') === 'success',
							'bg-error/10 text-error': typeVariant(entryMap?.[rel.toEntryId]?.entryType ?? '') === 'error',
						}"
					>
						{{ typeLabel(entryMap?.[rel.toEntryId]?.entryType ?? '') }}
					</span>

					<button
						v-if="!readonly"
						type="button"
						class="flex-shrink-0 w-6 h-6 rounded-md flex items-center justify-center text-text-tertiary hover:text-error hover:bg-error-subtle transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
						:class="entryMap?.[rel.toEntryId]?.entryType ? '' : 'ml-auto'"
						aria-label="Remove relation"
						@click="emit('remove', rel._id)"
					>
						<Icon name="lucide:x" class="w-3.5 h-3.5" />
					</button>
				</div>
			</div>
		</div>

		<!-- Incoming Relations -->
		<div>
			<h4 class="text-sm font-medium text-text-secondary mb-3 flex items-center gap-2">
				<Icon name="lucide:arrow-left" class="w-4 h-4" />
				Incoming Relations
				<span class="text-text-tertiary font-normal">({{ incomingRelations.length }})</span>
			</h4>

			<div v-if="incomingRelations.length === 0" class="text-sm text-text-tertiary py-3 pl-6">
				No incoming relations.
			</div>

			<div v-else class="space-y-2">
				<div
					v-for="rel in incomingRelations"
					:key="`in-${rel._id}`"
					class="flex items-center gap-3 py-2 px-3 rounded-lg bg-bg-surface group"
				>
					<Icon name="lucide:arrow-left" class="w-3.5 h-3.5 text-text-tertiary flex-shrink-0" />

					<span
						class="text-xs font-medium px-2 py-0.5 rounded-full flex-shrink-0"
						:class="relationBadgeClass(rel.relationType)"
					>
						{{ relationLabel(rel.relationType) }}
					</span>

					<NuxtLink
						:to="`/dashboard/knowledge/${rel.fromEntryId}`"
						class="text-sm text-text-primary hover:text-brand transition-colors truncate"
					>
						{{ entryMap?.[rel.fromEntryId]?.title ?? rel.fromEntryId }}
					</NuxtLink>

					<span
						v-if="entryMap?.[rel.fromEntryId]?.entryType"
						class="text-[10px] font-medium px-1.5 py-0.5 rounded-full uppercase tracking-wide flex-shrink-0 ml-auto"
						:class="{
							'bg-brand-subtle text-brand': typeVariant(entryMap?.[rel.fromEntryId]?.entryType ?? '') === 'default',
							'bg-warning/10 text-warning': typeVariant(entryMap?.[rel.fromEntryId]?.entryType ?? '') === 'warning',
							'bg-bg-surface text-text-tertiary': typeVariant(entryMap?.[rel.fromEntryId]?.entryType ?? '') === 'neutral',
							'bg-success-subtle text-success': typeVariant(entryMap?.[rel.fromEntryId]?.entryType ?? '') === 'success',
							'bg-error/10 text-error': typeVariant(entryMap?.[rel.fromEntryId]?.entryType ?? '') === 'error',
						}"
					>
						{{ typeLabel(entryMap?.[rel.fromEntryId]?.entryType ?? '') }}
					</span>

					<button
						v-if="!readonly"
						type="button"
						class="flex-shrink-0 w-6 h-6 rounded-md flex items-center justify-center text-text-tertiary hover:text-error hover:bg-error-subtle transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
						:class="entryMap?.[rel.fromEntryId]?.entryType ? '' : 'ml-auto'"
						aria-label="Remove relation"
						@click="emit('remove', rel._id)"
					>
						<Icon name="lucide:x" class="w-3.5 h-3.5" />
					</button>
				</div>
			</div>
		</div>
	</div>
</template>
