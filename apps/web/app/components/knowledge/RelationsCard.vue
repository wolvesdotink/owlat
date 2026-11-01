<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { RELATION_TYPES, entryTypeIcon, type RelationType } from '~/utils/knowledgeEntryTypes';
import { useKnowledgeDetailLabels } from '~/composables/useKnowledgeDetailLabels';
import { CloseIcon, PlusIcon } from '@coolicons/vue';

type Relation = {
	_id: string;
	relationType: string;
	fromEntryId: string;
	toEntryId: string;
};

/**
 * The knowledge entry detail page's Relations card: the entry's typed edges and
 * the form that adds one. This is the user-facing write path for the knowledge
 * graph's edges; the pipeline is the only other writer.
 */
const props = defineProps<{
	entryId: Id<'knowledgeEntries'>;
	outgoingRelations: Relation[];
	incomingRelations: Relation[];
	/** Resolved entry map: entryId → { title, entryType } */
	entryMap: Record<string, { title: string; entryType: string }>;
}>();

const { t } = useI18n();
const { showToast } = useToast();
const { entryTypeName, relationTypeName } = useKnowledgeDetailLabels();

const { run: addRelation } = useBackendOperation(api.knowledge.graph.addRelation, {
	label: () => t('shared.useKnowledgeGraph.operations.addRelation'),
});
const { run: removeRelation } = useBackendOperation(api.knowledge.graph.removeRelation, {
	label: () => t('shared.useKnowledgeGraph.operations.removeRelation'),
});

const hasRelations = computed(
	() => props.outgoingRelations.length > 0 || props.incomingRelations.length > 0
);

const showRelationForm = ref(false);
const relationType = ref<RelationType>('relates_to');
const relationSearch = ref('');
const selectedTarget = ref<{ id: Id<'knowledgeEntries'>; title: string } | null>(null);
const isSavingRelation = ref(false);

// Search the graph for the target entry to relate to. Skipped until the user
// types — the FTS `search` query already powers the index page's search box.
const { data: relationSearchResults } = useConvexQuery(api.knowledge.graph.search, () => {
	const q = relationSearch.value.trim();
	if (!q) return 'skip';
	return { searchQuery: q, limit: 8 };
});

// Exclude the current entry (no self-edge) from the picker results.
const relationCandidates = computed(() =>
	(relationSearchResults.value ?? []).filter((e) => e._id !== props.entryId)
);

const resetRelationForm = () => {
	showRelationForm.value = false;
	relationType.value = 'relates_to';
	relationSearch.value = '';
	selectedTarget.value = null;
};

const selectTarget = (candidate: { _id: Id<'knowledgeEntries'>; title: string }) => {
	selectedTarget.value = { id: candidate._id, title: candidate.title };
	relationSearch.value = '';
};

const handleAddRelation = async () => {
	if (!selectedTarget.value || isSavingRelation.value) return;
	isSavingRelation.value = true;
	try {
		const result = await addRelation({
			fromEntryId: props.entryId,
			toEntryId: selectedTarget.value.id,
			relationType: relationType.value,
		});
		if (!result.ok) return;
		showToast(t('dashboard.knowledge.detail.relationAddedToast'));
		resetRelationForm();
	} finally {
		isSavingRelation.value = false;
	}
};

const handleRemoveRelation = async (relationId: string) => {
	const result = await removeRelation({ relationId: relationId as Id<'knowledgeRelations'> });
	if (!result.ok) return;
	showToast(t('dashboard.knowledge.detail.relationRemovedToast'));
};
</script>

<template>
	<div class="rounded-(--radius-card) bg-surface-2 shadow-surface-1 p-5">
		<div class="flex items-center justify-between mb-4">
			<h3 class="text-sm font-semibold text-text-primary">
				{{ t('dashboard.knowledge.detail.relations') }}
			</h3>
			<UiButton
				variant="secondary"
				size="sm"
				v-if="!showRelationForm"
				type="button"
				class="gap-1.5"
				@click="showRelationForm = true"
			>
				<PlusIcon class="w-3.5 h-3.5" />
				{{ t('dashboard.knowledge.detail.addRelation') }}
			</UiButton>
		</div>

		<!-- Add-relation form -->
		<div
			v-if="showRelationForm"
			class="rounded-lg bg-bg-surface shadow-surface-1 p-4 mb-4 space-y-3"
		>
			<div>
				<label for="relation-type" class="block text-xs font-medium text-text-secondary mb-1.5">
					{{ t('dashboard.knowledge.detail.thisEntry') }}
				</label>
				<select id="relation-type" v-model="relationType" class="input w-full">
					<option v-for="rt in RELATION_TYPES" :key="rt" :value="rt">
						{{ relationTypeName(rt) }}
					</option>
				</select>
			</div>

			<div>
				<label for="relation-target" class="block text-xs font-medium text-text-secondary mb-1.5">
					{{ t('dashboard.knowledge.detail.relatedEntry') }}
				</label>
				<div
					v-if="selectedTarget"
					class="flex items-center justify-between gap-2 py-2 px-3 rounded-lg bg-bg-elevated shadow-surface-1"
				>
					<span class="text-sm text-text-primary truncate">{{ selectedTarget.title }}</span>
					<button
						type="button"
						class="rounded text-text-tertiary hover:text-text-primary transition-colors flex-shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
						:aria-label="t('dashboard.knowledge.detail.clearSelection')"
						@click="selectedTarget = null"
					>
						<CloseIcon class="w-3.5 h-3.5" />
					</button>
				</div>
				<template v-else>
					<input
						id="relation-target"
						v-model="relationSearch"
						type="text"
						:placeholder="t('dashboard.knowledge.detail.relationSearchPlaceholder')"
						class="input w-full"
						autocomplete="off"
					/>
					<div
						v-if="relationSearch.trim() && relationCandidates.length > 0"
						class="mt-2 rounded-lg bg-bg-elevated shadow-surface-1 overflow-hidden divide-y divide-border-subtle"
					>
						<button
							v-for="candidate in relationCandidates"
							:key="candidate._id"
							type="button"
							class="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-bg-surface transition-colors"
							@click="selectTarget(candidate)"
						>
							<component
								:is="entryTypeIcon(candidate.entryType)"
								class="w-3.5 h-3.5 text-text-tertiary flex-shrink-0"
							/>
							<span class="text-sm text-text-primary truncate">{{ candidate.title }}</span>
							<span
								class="text-2xs uppercase tracking-wide text-text-tertiary ml-auto flex-shrink-0"
							>
								{{ entryTypeName(candidate.entryType) }}
							</span>
						</button>
					</div>
					<p v-else-if="relationSearch.trim()" class="text-xs text-text-tertiary mt-2">
						{{ t('dashboard.knowledge.detail.noMatchingEntries') }}
					</p>
				</template>
			</div>

			<div class="flex items-center justify-end gap-2 pt-1">
				<UiButton variant="secondary" size="sm" type="button" @click="resetRelationForm">
					{{ t('common.cancel') }}
				</UiButton>
				<UiButton
					size="sm"
					type="button"
					:disabled="!selectedTarget || isSavingRelation"
					@click="handleAddRelation"
				>
					{{
						isSavingRelation
							? t('dashboard.knowledge.detail.addingRelation')
							: t('dashboard.knowledge.detail.addRelation')
					}}
				</UiButton>
			</div>
		</div>

		<KnowledgeRelationsList
			v-if="hasRelations"
			:outgoing-relations="outgoingRelations"
			:incoming-relations="incomingRelations"
			:entry-map="entryMap"
			@remove="handleRemoveRelation"
		/>
		<p v-else-if="!showRelationForm" class="text-sm text-text-tertiary">
			{{ t('dashboard.knowledge.detail.noRelations') }}
		</p>
	</div>
</template>
