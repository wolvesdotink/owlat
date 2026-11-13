<script setup lang="ts">
import { relationLabel, relationBadgeClass } from '~/utils/knowledgeEntryTypes';
import { ArrowLeftIcon, ArrowRightIcon, CloseIcon } from '@coolicons/vue';

type Relation = {
	_id: string;
	relationType: string;
	fromEntryId: string;
	toEntryId: string;
};

const props = withDefaults(
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
	{ readonly: false }
);

const emit = defineEmits<{
	remove: [relationId: string];
}>();

const { typeVariant, typeLabel } = useKnowledgeGraph();

const { t, te } = useI18n();

// Relation / entry-type labels are translated here: the shared presentation map
// (`~/utils/knowledgeEntryTypes`) stays a plain constant, so a value the catalog
// doesn't know still falls back to its raw label instead of a key path.
const relationTypeLabel = (type: string) => {
	const key = `components.knowledge.relationsList.relationTypes.${type}`;
	return te(key) ? t(key) : relationLabel(type);
};
const entryTypeLabel = (type: string) => {
	const key = `components.knowledge.relationsList.entryTypes.${type}`;
	return te(key) ? t(key) : typeLabel(type);
};
// An entry the map does not resolve (deleted, or not visible to this member)
// gets a readable placeholder, never its raw id.
const entryTitle = (entryId: string) =>
	props.entryMap?.[entryId]?.title ?? t('components.knowledge.relationsList.unknownEntry');
const entryTypeChipClass = (type: string) =>
	({
		default: 'bg-brand-subtle text-brand',
		warning: 'bg-warning/10 text-warning',
		neutral: 'bg-bg-surface text-text-tertiary',
		success: 'bg-success-subtle text-success',
		error: 'bg-error/10 text-error',
	})[typeVariant(type)] ?? 'bg-bg-surface text-text-tertiary';
</script>

<template>
	<div class="@container space-y-6">
		<!-- Outgoing Relations -->
		<div>
			<h4 class="text-sm font-medium text-text-secondary mb-3 flex items-center gap-2">
				<ArrowRightIcon class="w-4 h-4" aria-hidden="true" />
				{{ t('components.knowledge.relationsList.outgoing') }}
				<span class="text-text-tertiary font-normal">{{
					t('components.knowledge.relationsList.count', { count: outgoingRelations.length })
				}}</span>
			</h4>

			<div v-if="outgoingRelations.length === 0" class="text-sm text-text-tertiary py-3 pl-6">
				{{ t('components.knowledge.relationsList.noOutgoing') }}
			</div>

			<div v-else class="space-y-2">
				<div
					v-for="rel in outgoingRelations"
					:key="`out-${rel._id}`"
					class="flex items-center gap-3 py-2 px-3 rounded-lg bg-bg-surface group"
				>
					<ArrowRightIcon class="w-3.5 h-3.5 text-text-tertiary flex-shrink-0" aria-hidden="true" />

					<span
						class="text-xs font-medium px-2 py-0.5 rounded-full flex-shrink-0"
						:class="relationBadgeClass(rel.relationType)"
					>
						{{ relationTypeLabel(rel.relationType) }}
					</span>

					<!-- native-title: the full title of an entry the link truncates -->
					<NuxtLink
						:to="`/dashboard/knowledge/${rel.toEntryId}`"
						class="min-w-0 flex-1 text-sm text-text-primary hover:text-brand transition-colors truncate"
						:title="entryTitle(rel.toEntryId)"
					>
						{{ entryTitle(rel.toEntryId) }}
					</NuxtLink>

					<!-- The entry type is secondary: it gives way first in a narrow
					     container (the graph side panel, a phone-width card). -->
					<span
						v-if="entryMap?.[rel.toEntryId]?.entryType"
						class="hidden @sm:inline text-2xs font-medium px-1.5 py-0.5 rounded-full uppercase tracking-wide flex-shrink-0"
						:class="entryTypeChipClass(entryMap?.[rel.toEntryId]?.entryType ?? '')"
					>
						{{ entryTypeLabel(entryMap?.[rel.toEntryId]?.entryType ?? '') }}
					</span>

					<!-- Hover-revealed on a mouse; always shown on touch, where there is no hover. -->
					<button
						v-if="!readonly"
						type="button"
						class="flex-shrink-0 w-6 h-6 rounded-md flex items-center justify-center text-text-tertiary hover:text-error hover:bg-error-subtle transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
						:aria-label="
							t('components.knowledge.relationsList.removeRelationNamed', {
								title: entryTitle(rel.toEntryId),
							})
						"
						@click="emit('remove', rel._id)"
					>
						<CloseIcon class="w-3.5 h-3.5" aria-hidden="true" />
					</button>
				</div>
			</div>
		</div>

		<!-- Incoming Relations -->
		<div>
			<h4 class="text-sm font-medium text-text-secondary mb-3 flex items-center gap-2">
				<ArrowLeftIcon class="w-4 h-4" aria-hidden="true" />
				{{ t('components.knowledge.relationsList.incoming') }}
				<span class="text-text-tertiary font-normal">{{
					t('components.knowledge.relationsList.count', { count: incomingRelations.length })
				}}</span>
			</h4>

			<div v-if="incomingRelations.length === 0" class="text-sm text-text-tertiary py-3 pl-6">
				{{ t('components.knowledge.relationsList.noIncoming') }}
			</div>

			<div v-else class="space-y-2">
				<div
					v-for="rel in incomingRelations"
					:key="`in-${rel._id}`"
					class="flex items-center gap-3 py-2 px-3 rounded-lg bg-bg-surface group"
				>
					<ArrowLeftIcon class="w-3.5 h-3.5 text-text-tertiary flex-shrink-0" aria-hidden="true" />

					<span
						class="text-xs font-medium px-2 py-0.5 rounded-full flex-shrink-0"
						:class="relationBadgeClass(rel.relationType)"
					>
						{{ relationTypeLabel(rel.relationType) }}
					</span>

					<!-- native-title: the full title of an entry the link truncates -->
					<NuxtLink
						:to="`/dashboard/knowledge/${rel.fromEntryId}`"
						class="min-w-0 flex-1 text-sm text-text-primary hover:text-brand transition-colors truncate"
						:title="entryTitle(rel.fromEntryId)"
					>
						{{ entryTitle(rel.fromEntryId) }}
					</NuxtLink>

					<!-- The entry type is secondary: it gives way first in a narrow
					     container (the graph side panel, a phone-width card). -->
					<span
						v-if="entryMap?.[rel.fromEntryId]?.entryType"
						class="hidden @sm:inline text-2xs font-medium px-1.5 py-0.5 rounded-full uppercase tracking-wide flex-shrink-0"
						:class="entryTypeChipClass(entryMap?.[rel.fromEntryId]?.entryType ?? '')"
					>
						{{ entryTypeLabel(entryMap?.[rel.fromEntryId]?.entryType ?? '') }}
					</span>

					<!-- Hover-revealed on a mouse; always shown on touch, where there is no hover. -->
					<button
						v-if="!readonly"
						type="button"
						class="flex-shrink-0 w-6 h-6 rounded-md flex items-center justify-center text-text-tertiary hover:text-error hover:bg-error-subtle transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
						:aria-label="
							t('components.knowledge.relationsList.removeRelationNamed', {
								title: entryTitle(rel.fromEntryId),
							})
						"
						@click="emit('remove', rel._id)"
					>
						<CloseIcon class="w-3.5 h-3.5" aria-hidden="true" />
					</button>
				</div>
			</div>
		</div>
	</div>
</template>
