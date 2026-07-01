<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { RELATION_TYPES, relationLabel, type RelationType } from '~/utils/knowledgeEntryTypes';

useHead({ title: 'Knowledge Entry — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const route = useRoute();
const router = useRouter();
const { showToast } = useToast();
const entryId = computed(() => route.params['id'] as Id<'knowledgeEntries'>);

const {
	typeVariant,
	typeIcon,
	typeLabel,
	sourceIcon,
	sourceLabel,
	confidenceColor,
	confidenceBgColor,
	formatConfidence,
	confidenceVariant,
	deleteEntry,
	addRelation,
	removeRelation,
} = useKnowledgeGraph();

// Fetch entry with relations
const { data: entryData, isLoading } = useOrganizationQuery(
	api.knowledge.graph.getEntry,
	() => ({ entryId: entryId.value }),
);

const entry = computed(() => entryData.value?.entry ?? null);
const outgoingRelations = computed(() => entryData.value?.outgoing ?? []);
const incomingRelations = computed(() => entryData.value?.incoming ?? []);
const hasRelations = computed(() => outgoingRelations.value.length > 0 || incomingRelations.value.length > 0);

// Build entry map for relation display by fetching related entries
// For now we show IDs; in production you'd batch-fetch related entry titles
const entryMap = computed(() => {
	// Related entries' titles/types come resolved from the backend; merge in self.
	const map: Record<string, { title: string; entryType: string }> = {
		...entryData.value?.relatedEntries,
	};
	if (entry.value) {
		map[entry.value._id] = { title: entry.value.title, entryType: entry.value.entryType };
	}
	return map;
});

const formattedCreatedAt = computed(() => {
	if (!entry.value) return '';
	return new Date(entry.value.createdAt).toLocaleDateString('en-US', {
		month: 'long',
		day: 'numeric',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
	});
});

const formattedUpdatedAt = computed(() => {
	if (!entry.value) return '';
	return new Date(entry.value.updatedAt).toLocaleDateString('en-US', {
		month: 'long',
		day: 'numeric',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
	});
});

const formattedExpiresAt = computed(() => {
	if (!entry.value?.expiresAt) return null;
	const date = new Date(entry.value.expiresAt);
	const isExpired = date.getTime() < Date.now();
	return {
		text: date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
		isExpired,
	};
});

// Edit / delete actions — the user-facing remedy for a wrong or typo'd entry.
const showEditForm = ref(false);
const showDeleteConfirm = ref(false);
const isDeleting = ref(false);

// Seed the edit form from the loaded entry.
const editInitialValues = computed(() => {
	if (!entry.value) return undefined;
	return {
		entryType: entry.value.entryType,
		title: entry.value.title,
		content: entry.value.content,
		sourceType: entry.value.sourceType,
		confidence: entry.value.confidence,
		tags: entry.value.tags,
		expiresAt: entry.value.expiresAt,
	};
});

const handleEdited = () => {
	showEditForm.value = false;
	showToast('Knowledge entry updated');
};

const handleDelete = async () => {
	isDeleting.value = true;
	try {
		const result = await deleteEntry({ entryId: entryId.value });
		if (result === undefined) return;
		showToast('Knowledge entry deleted');
		router.push('/dashboard/knowledge');
	} finally {
		isDeleting.value = false;
	}
};

// ── Relation authoring ──
// The user-facing write path for the knowledge graph's typed edges. Before this,
// `knowledgeRelations` was read-but-never-written outside the pipeline/tests, so
// the "navigable graph" the index page advertises was always disconnected nodes.
const showRelationForm = ref(false);
const relationType = ref<RelationType>('relates_to');
const relationSearch = ref('');
const selectedTarget = ref<{ id: Id<'knowledgeEntries'>; title: string } | null>(null);
const isSavingRelation = ref(false);

// Search the graph for the target entry to relate to. Skipped until the user
// types — the FTS `search` query already powers the index page's search box.
const { data: relationSearchResults } = useConvexQuery(
	api.knowledge.graph.search,
	() => {
		const q = relationSearch.value.trim();
		if (!q) return 'skip';
		return { searchQuery: q, limit: 8 };
	},
);

// Exclude the current entry (no self-edge) from the picker results.
const relationCandidates = computed(() =>
	(relationSearchResults.value ?? []).filter((e) => e._id !== entryId.value),
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
			fromEntryId: entryId.value,
			toEntryId: selectedTarget.value.id,
			relationType: relationType.value,
		});
		if (result === undefined) return;
		showToast('Relation added');
		resetRelationForm();
	} finally {
		isSavingRelation.value = false;
	}
};

const handleRemoveRelation = async (relationId: string) => {
	const result = await removeRelation({ relationId: relationId as Id<'knowledgeRelations'> });
	if (result === undefined) return;
	showToast('Relation removed');
};
</script>

<template>
	<div class="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-6">
		<!-- Back link -->
		<NuxtLink
			to="/dashboard/knowledge"
			class="inline-flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors"
		>
			<Icon name="lucide:arrow-left" class="w-4 h-4" />
			Back to Knowledge Graph
		</NuxtLink>

		<!-- Loading -->
		<div v-if="isLoading" class="flex items-center justify-center py-20">
			<UiSpinner />
		</div>

		<!-- Not Found -->
		<div
			v-else-if="!entry"
			class="flex flex-col items-center justify-center py-20 text-center"
		>
			<div class="w-14 h-14 rounded-full bg-bg-surface border border-border-subtle flex items-center justify-center mb-4">
				<Icon name="lucide:file-question" class="w-7 h-7 text-text-tertiary" />
			</div>
			<h3 class="text-base font-medium text-text-primary">Entry not found</h3>
			<p class="text-sm text-text-secondary mt-1">
				This knowledge entry may have been deleted or expired.
			</p>
			<NuxtLink to="/dashboard/knowledge" class="mt-4 btn btn-primary">
				Browse Knowledge Graph
			</NuxtLink>
		</div>

		<!-- Entry Detail -->
		<template v-else>
			<!-- Header -->
			<div class="flex items-start justify-between gap-4">
				<div class="flex items-start gap-4 min-w-0">
				<div
					class="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0"
					:class="{
						'bg-brand-subtle text-brand': typeVariant(entry.entryType) === 'default',
						'bg-warning/10 text-warning': typeVariant(entry.entryType) === 'warning',
						'bg-bg-surface text-text-secondary': typeVariant(entry.entryType) === 'neutral',
						'bg-success-subtle text-success': typeVariant(entry.entryType) === 'success',
						'bg-error/10 text-error': typeVariant(entry.entryType) === 'error',
					}"
				>
					<Icon :name="typeIcon(entry.entryType)" class="w-6 h-6" />
				</div>
				<div class="min-w-0">
					<div class="flex items-center gap-2 mb-1">
						<h1 class="text-xl font-bold text-text-primary">{{ entry.title }}</h1>
						<span
							class="text-xs font-medium px-2 py-0.5 rounded-full uppercase tracking-wide"
							:class="{
								'bg-brand-subtle text-brand': typeVariant(entry.entryType) === 'default',
								'bg-warning/10 text-warning': typeVariant(entry.entryType) === 'warning',
								'bg-bg-surface text-text-tertiary': typeVariant(entry.entryType) === 'neutral',
								'bg-success-subtle text-success': typeVariant(entry.entryType) === 'success',
								'bg-error/10 text-error': typeVariant(entry.entryType) === 'error',
							}"
						>
							{{ typeLabel(entry.entryType) }}
						</span>
					</div>
					<p class="text-sm text-text-tertiary">
						Created {{ formattedCreatedAt }}
					</p>
				</div>
				</div>

				<!-- Actions -->
				<div class="flex items-center gap-2 flex-shrink-0">
					<button class="btn btn-secondary gap-2" @click="showEditForm = true">
						<Icon name="lucide:pencil" class="w-4 h-4" />
						Edit
					</button>
					<button
						class="btn border border-error/30 text-error hover:bg-error-subtle transition-colors gap-2"
						@click="showDeleteConfirm = true"
					>
						<Icon name="lucide:trash-2" class="w-4 h-4" />
						Delete
					</button>
				</div>
			</div>

			<div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
				<!-- Main Content -->
				<div class="lg:col-span-2 space-y-6">
					<!-- Content -->
					<div class="rounded-xl border border-border-subtle bg-bg-elevated p-5">
						<h3 class="text-sm font-semibold text-text-primary mb-3">Content</h3>
						<p class="text-sm text-text-secondary whitespace-pre-wrap leading-relaxed">
							{{ entry.content }}
						</p>
					</div>

					<!-- Tags -->
					<div
						v-if="entry.tags && entry.tags.length > 0"
						class="rounded-xl border border-border-subtle bg-bg-elevated p-5"
					>
						<h3 class="text-sm font-semibold text-text-primary mb-3">Tags</h3>
						<div class="flex flex-wrap gap-2">
							<span
								v-for="tag in entry.tags"
								:key="tag"
								class="text-xs px-2.5 py-1 rounded-full bg-bg-surface text-text-secondary border border-border-subtle"
							>
								{{ tag }}
							</span>
						</div>
					</div>

					<!-- Relations -->
					<div class="rounded-xl border border-border-subtle bg-bg-elevated p-5">
						<div class="flex items-center justify-between mb-4">
							<h3 class="text-sm font-semibold text-text-primary">Relations</h3>
							<button
								v-if="!showRelationForm"
								type="button"
								class="btn btn-secondary btn-sm gap-1.5"
								@click="showRelationForm = true"
							>
								<Icon name="lucide:plus" class="w-3.5 h-3.5" />
								Add relation
							</button>
						</div>

						<!-- Add-relation form -->
						<div
							v-if="showRelationForm"
							class="rounded-lg border border-border-subtle bg-bg-surface p-4 mb-4 space-y-3"
						>
							<div>
								<label for="relation-type" class="block text-xs font-medium text-text-secondary mb-1.5">
									This entry
								</label>
								<select id="relation-type" v-model="relationType" class="input w-full">
									<option v-for="rt in RELATION_TYPES" :key="rt" :value="rt">
										{{ relationLabel(rt) }}
									</option>
								</select>
							</div>

							<div>
								<label for="relation-target" class="block text-xs font-medium text-text-secondary mb-1.5">
									Related entry
								</label>
								<div
									v-if="selectedTarget"
									class="flex items-center justify-between gap-2 py-2 px-3 rounded-lg bg-bg-elevated border border-border-subtle"
								>
									<span class="text-sm text-text-primary truncate">{{ selectedTarget.title }}</span>
									<button
										type="button"
										class="text-text-tertiary hover:text-text-primary transition-colors flex-shrink-0"
										aria-label="Clear selection"
										@click="selectedTarget = null"
									>
										<Icon name="lucide:x" class="w-3.5 h-3.5" />
									</button>
								</div>
								<template v-else>
									<input
										id="relation-target"
										v-model="relationSearch"
										type="text"
										placeholder="Search for an entry to relate…"
										class="input w-full"
										autocomplete="off"
									/>
									<div
										v-if="relationSearch.trim() && relationCandidates.length > 0"
										class="mt-2 rounded-lg border border-border-subtle bg-bg-elevated overflow-hidden divide-y divide-border-subtle"
									>
										<button
											v-for="candidate in relationCandidates"
											:key="candidate._id"
											type="button"
											class="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-bg-surface transition-colors"
											@click="selectTarget(candidate)"
										>
											<Icon
												:name="typeIcon(candidate.entryType)"
												class="w-3.5 h-3.5 text-text-tertiary flex-shrink-0"
											/>
											<span class="text-sm text-text-primary truncate">{{ candidate.title }}</span>
											<span class="text-[10px] uppercase tracking-wide text-text-tertiary ml-auto flex-shrink-0">
												{{ typeLabel(candidate.entryType) }}
											</span>
										</button>
									</div>
									<p
										v-else-if="relationSearch.trim()"
										class="text-xs text-text-tertiary mt-2"
									>
										No matching entries.
									</p>
								</template>
							</div>

							<div class="flex items-center justify-end gap-2 pt-1">
								<button type="button" class="btn btn-secondary btn-sm" @click="resetRelationForm">
									Cancel
								</button>
								<button
									type="button"
									class="btn btn-primary btn-sm"
									:disabled="!selectedTarget || isSavingRelation"
									@click="handleAddRelation"
								>
									{{ isSavingRelation ? 'Adding…' : 'Add relation' }}
								</button>
							</div>
						</div>

						<KnowledgeRelationsList
							v-if="hasRelations"
							:outgoing-relations="outgoingRelations"
							:incoming-relations="incomingRelations"
							:entry-map="entryMap"
							@remove="handleRemoveRelation"
						/>
						<p
							v-else-if="!showRelationForm"
							class="text-sm text-text-tertiary"
						>
							No relations yet. Link this entry to another to build out the knowledge graph.
						</p>
					</div>
				</div>

				<!-- Sidebar Metadata -->
				<div class="space-y-4">
					<!-- Confidence -->
					<div class="rounded-xl border border-border-subtle bg-bg-elevated p-5">
						<h3 class="text-sm font-semibold text-text-primary mb-3">Confidence</h3>
						<div class="flex items-center gap-3">
							<UiProgressBar
								class="w-24"
								size="sm"
								:value="entry.confidence * 100"
								:variant="confidenceVariant(entry.confidence)"
								aria-label="Confidence"
							/>
							<span
								class="text-sm font-semibold"
								:class="confidenceColor(entry.confidence)"
							>
								{{ formatConfidence(entry.confidence) }}
							</span>
						</div>
						<p class="text-xs text-text-tertiary mt-2">
							Confidence decays over time, with recent use slowing the decay.
						</p>
					</div>

					<!-- Source -->
					<div class="rounded-xl border border-border-subtle bg-bg-elevated p-5">
						<h3 class="text-sm font-semibold text-text-primary mb-3">Source</h3>
						<div class="flex items-center gap-2">
							<div class="w-8 h-8 rounded-lg bg-bg-surface flex items-center justify-center">
								<Icon :name="sourceIcon(entry.sourceType)" class="w-4 h-4 text-text-secondary" />
							</div>
							<div>
								<p class="text-sm font-medium text-text-primary">{{ sourceLabel(entry.sourceType) }}</p>
								<p v-if="entry.sourceId" class="text-xs text-text-tertiary truncate max-w-[160px]">
									{{ entry.sourceId }}
								</p>
							</div>
						</div>
						<NuxtLink
							v-if="entry.threadId"
							:to="`/dashboard/inbox?thread=${entry.threadId}`"
							class="mt-3 inline-flex items-center gap-1.5 text-xs text-brand hover:text-brand/80 transition-colors"
						>
							<Icon name="lucide:message-square" class="w-3.5 h-3.5" />
							View source thread
						</NuxtLink>
					</div>

					<!-- Dates -->
					<div class="rounded-xl border border-border-subtle bg-bg-elevated p-5">
						<h3 class="text-sm font-semibold text-text-primary mb-3">Details</h3>
						<dl class="space-y-2.5 text-sm">
							<div class="flex justify-between">
								<dt class="text-text-tertiary">Created</dt>
								<dd class="text-text-secondary">{{ formattedCreatedAt }}</dd>
							</div>
							<div class="flex justify-between">
								<dt class="text-text-tertiary">Updated</dt>
								<dd class="text-text-secondary">{{ formattedUpdatedAt }}</dd>
							</div>
							<div v-if="formattedExpiresAt" class="flex justify-between">
								<dt class="text-text-tertiary">Expires</dt>
								<dd
									:class="formattedExpiresAt.isExpired ? 'text-error' : 'text-text-secondary'"
								>
									{{ formattedExpiresAt.text }}
									<span v-if="formattedExpiresAt.isExpired" class="text-xs">(expired)</span>
								</dd>
							</div>
						</dl>
					</div>

					<!-- Linked Contacts -->
					<div
						v-if="entry.contactIds && entry.contactIds.length > 0"
						class="rounded-xl border border-border-subtle bg-bg-elevated p-5"
					>
						<h3 class="text-sm font-semibold text-text-primary mb-3">Linked Contacts</h3>
						<div class="space-y-2">
							<NuxtLink
								v-for="contactId in entry.contactIds"
								:key="contactId"
								:to="`/dashboard/audience/contacts/${contactId}`"
								class="flex items-center gap-2 py-1.5 text-sm text-text-primary hover:text-brand transition-colors"
							>
								<Icon name="lucide:user" class="w-3.5 h-3.5 text-text-tertiary" />
								<span class="truncate">{{ contactId }}</span>
								<Icon name="lucide:external-link" class="w-3 h-3 text-text-tertiary ml-auto" />
							</NuxtLink>
						</div>
					</div>
				</div>
			</div>
		</template>

		<!-- Edit Entry Modal -->
		<Teleport to="body">
			<Transition
				enter-active-class="transition-opacity duration-200"
				enter-from-class="opacity-0"
				enter-to-class="opacity-100"
				leave-active-class="transition-opacity duration-150"
				leave-from-class="opacity-100"
				leave-to-class="opacity-0"
			>
				<div
					v-if="showEditForm && entry"
					class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
					@click.self="showEditForm = false"
				>
					<div
						class="w-full max-w-lg bg-bg-elevated border border-border-subtle rounded-xl shadow-xl max-h-[90vh] overflow-y-auto"
					>
						<div class="flex items-center justify-between px-5 py-4 border-b border-border-subtle sticky top-0 bg-bg-elevated z-10">
							<h3 class="text-base font-semibold text-text-primary">Edit Knowledge Entry</h3>
							<button
								class="w-8 h-8 rounded-lg flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-bg-surface transition-colors"
								@click="showEditForm = false"
							 aria-label="Close">
								<Icon name="lucide:x" class="w-4 h-4" />
							</button>
						</div>
						<div class="px-5 py-4">
							<KnowledgeEntryForm
								is-edit
								:entry-id="entryId"
								:initial-values="editInitialValues"
								@saved="handleEdited"
								@cancelled="showEditForm = false"
							/>
						</div>
					</div>
				</div>
			</Transition>
		</Teleport>

		<!-- Delete confirmation -->
		<Teleport to="body">
			<Transition
				enter-active-class="duration-200 ease-out"
				enter-from-class="opacity-0"
				enter-to-class="opacity-100"
				leave-active-class="duration-150 ease-in"
				leave-from-class="opacity-100"
				leave-to-class="opacity-0"
			>
				<div
					v-if="showDeleteConfirm"
					class="fixed inset-0 z-50 flex items-center justify-center p-4"
				>
					<div class="absolute inset-0 bg-black/60" @click="showDeleteConfirm = false" />
					<div class="relative bg-bg-elevated border border-border-subtle rounded-2xl p-6 w-full max-w-sm">
						<h3 class="text-lg font-semibold text-text-primary mb-2">Delete Knowledge Entry</h3>
						<p class="text-sm text-text-secondary mb-6">
							This permanently removes this entry from the knowledge graph so it no longer feeds the agent's drafting context. This action cannot be undone.
						</p>
						<div class="flex items-center justify-end gap-3">
							<button class="btn btn-secondary" @click="showDeleteConfirm = false">Cancel</button>
							<button
								class="btn bg-error text-white hover:bg-error/90"
								:disabled="isDeleting"
								@click="handleDelete"
							>
								{{ isDeleting ? 'Deleting...' : 'Delete' }}
							</button>
						</div>
					</div>
				</div>
			</Transition>
		</Teleport>
	</div>
</template>
