<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { RELATION_TYPES, relationLabel, type RelationType } from '~/utils/knowledgeEntryTypes';

const { t, te, locale } = useI18n();

useHead({ title: () => t('dashboard.knowledge.detail.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const router = useRouter();
const { showToast } = useToast();
const entryId = useRouteId<'knowledgeEntries'>();

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
const { data: entryData, isLoading } = useOrganizationQuery(api.knowledge.graph.getEntry, () => ({
	entryId: entryId.value,
}));

const entry = computed(() => entryData.value?.entry ?? null);
const outgoingRelations = computed(() => entryData.value?.outgoing ?? []);
const incomingRelations = computed(() => entryData.value?.incoming ?? []);
const hasRelations = computed(
	() => outgoingRelations.value.length > 0 || incomingRelations.value.length > 0
);

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

// Entry-type / source / relation labels are translated here; the shared
// presentation map (`~/utils/knowledgeEntryTypes`) stays a plain constant, so an
// unknown value still falls back to its raw label instead of a key path.
const entryTypeName = (type: string): string => {
	const key = `dashboard.knowledge.detail.entryTypes.${type}`;
	return te(key) ? t(key) : typeLabel(type);
};
const sourceTypeName = (source: string): string => {
	const key = `dashboard.knowledge.detail.sourceTypes.${source}`;
	return te(key) ? t(key) : sourceLabel(source);
};
const relationTypeName = (type: string): string => {
	const key = `dashboard.knowledge.detail.relationTypes.${type}`;
	return te(key) ? t(key) : relationLabel(type);
};

const dateTimeFormat = computed(
	() =>
		new Intl.DateTimeFormat(locale.value, {
			month: 'long',
			day: 'numeric',
			year: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
		})
);
const dateFormat = computed(
	() => new Intl.DateTimeFormat(locale.value, { month: 'long', day: 'numeric', year: 'numeric' })
);

const formattedCreatedAt = computed(() => {
	if (!entry.value) return '';
	return dateTimeFormat.value.format(new Date(entry.value.createdAt));
});

const formattedUpdatedAt = computed(() => {
	if (!entry.value) return '';
	return dateTimeFormat.value.format(new Date(entry.value.updatedAt));
});

const formattedExpiresAt = computed(() => {
	if (!entry.value?.expiresAt) return null;
	const date = new Date(entry.value.expiresAt);
	const isExpired = date.getTime() < Date.now();
	return {
		text: dateFormat.value.format(date),
		isExpired,
	};
});

// Edit / delete actions — the user-facing remedy for a wrong or typo'd entry.
const showEditForm = ref(false);
const showDeleteConfirm = ref(false);
const isDeleting = ref(false);
const commitmentStatus = ref<'open' | 'fulfilled' | 'cancelled'>('open');
const setCommitmentStatus = useBackendOperation(api.knowledge.graph.setCommitmentStatus, {
	label: () => t('dashboard.knowledge.detail.commitmentStatusOperation'),
});

watch(
	entry,
	(value) => {
		commitmentStatus.value = value?.commitmentStatus ?? 'open';
	},
	{ immediate: true }
);

async function saveCommitmentStatus() {
	const result = await setCommitmentStatus.run({
		entryId: entryId.value,
		commitmentStatus: commitmentStatus.value,
	});
	if (result.ok) showToast(t('dashboard.knowledge.detail.commitmentStatusToast'));
}

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
	showToast(t('dashboard.knowledge.detail.updatedToast'));
};

const handleDelete = async () => {
	isDeleting.value = true;
	try {
		const result = await deleteEntry({ entryId: entryId.value });
		if (!result.ok) return;
		showToast(t('dashboard.knowledge.detail.deletedToast'));
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
const { data: relationSearchResults } = useConvexQuery(api.knowledge.graph.search, () => {
	const q = relationSearch.value.trim();
	if (!q) return 'skip';
	return { searchQuery: q, limit: 8 };
});

// Exclude the current entry (no self-edge) from the picker results.
const relationCandidates = computed(() =>
	(relationSearchResults.value ?? []).filter((e) => e._id !== entryId.value)
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
	<div class="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-6">
		<!-- Back link -->
		<NuxtLink
			to="/dashboard/knowledge"
			class="inline-flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors"
		>
			<Icon name="lucide:arrow-left" class="w-4 h-4" />
			{{ t('dashboard.knowledge.detail.backToGraph') }}
		</NuxtLink>

		<!-- Loading -->
		<div v-if="isLoading" class="flex items-center justify-center py-20">
			<UiSpinner />
		</div>

		<!-- Not Found -->
		<div v-else-if="!entry" class="flex flex-col items-center justify-center py-20 text-center">
			<div
				class="w-14 h-14 rounded-full bg-bg-surface shadow-surface-1 flex items-center justify-center mb-4"
			>
				<Icon name="lucide:file-question" class="w-7 h-7 text-text-tertiary" />
			</div>
			<h3 class="text-base font-medium text-text-primary">
				{{ t('dashboard.knowledge.detail.notFoundTitle') }}
			</h3>
			<p class="text-sm text-text-secondary mt-1">
				{{ t('dashboard.knowledge.detail.notFoundBody') }}
			</p>
			<UiButton to="/dashboard/knowledge" class="mt-4">
				{{ t('dashboard.knowledge.detail.browseGraph') }}
			</UiButton>
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
							<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
								{{ entry.title }}
							</h1>
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
								{{ entryTypeName(entry.entryType) }}
							</span>
						</div>
						<p class="text-sm text-text-tertiary">
							{{ t('dashboard.knowledge.detail.createdAt', { date: formattedCreatedAt }) }}
						</p>
					</div>
				</div>

				<!-- Actions -->
				<div class="flex items-center gap-2 flex-shrink-0">
					<UiButton variant="secondary" class="gap-2" @click="showEditForm = true">
						<Icon name="lucide:pencil" class="w-4 h-4" />
						{{ t('common.edit') }}
					</UiButton>
					<UiButton variant="danger-outline" class="gap-2" @click="showDeleteConfirm = true">
						<Icon name="lucide:trash-2" class="w-4 h-4" />
						{{ t('common.delete') }}
					</UiButton>
				</div>
			</div>

			<div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
				<!-- Main Content -->
				<div class="lg:col-span-2 space-y-6">
					<!-- Content -->
					<div class="rounded-(--radius-card) bg-surface-2 shadow-surface-1 p-5">
						<h3 class="text-sm font-semibold text-text-primary mb-3">
							{{ t('dashboard.knowledge.detail.content') }}
						</h3>
						<p class="text-sm text-text-secondary whitespace-pre-wrap leading-relaxed">
							{{ entry.content }}
						</p>
					</div>

					<!-- Tags -->
					<div
						v-if="entry.tags && entry.tags.length > 0"
						class="rounded-(--radius-card) bg-surface-2 shadow-surface-1 p-5"
					>
						<h3 class="text-sm font-semibold text-text-primary mb-3">
							{{ t('dashboard.knowledge.detail.tags') }}
						</h3>
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
								<Icon name="lucide:plus" class="w-3.5 h-3.5" />
								{{ t('dashboard.knowledge.detail.addRelation') }}
							</UiButton>
						</div>

						<!-- Add-relation form -->
						<div
							v-if="showRelationForm"
							class="rounded-lg bg-bg-surface shadow-surface-1 p-4 mb-4 space-y-3"
						>
							<div>
								<label
									for="relation-type"
									class="block text-xs font-medium text-text-secondary mb-1.5"
								>
									{{ t('dashboard.knowledge.detail.thisEntry') }}
								</label>
								<select id="relation-type" v-model="relationType" class="input w-full">
									<option v-for="rt in RELATION_TYPES" :key="rt" :value="rt">
										{{ relationTypeName(rt) }}
									</option>
								</select>
							</div>

							<div>
								<label
									for="relation-target"
									class="block text-xs font-medium text-text-secondary mb-1.5"
								>
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
										<Icon name="lucide:x" class="w-3.5 h-3.5" />
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
											<Icon
												:name="typeIcon(candidate.entryType)"
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
				</div>

				<!-- Sidebar Metadata -->
				<div class="space-y-4">
					<div
						v-if="entry.entryType === 'decision' || entry.entryType === 'action_item'"
						class="rounded-(--radius-card) bg-surface-2 shadow-surface-1 p-5"
					>
						<h3 class="mb-3 text-sm font-semibold text-text-primary">
							{{ t('dashboard.knowledge.detail.commitmentStatus') }}
						</h3>
						<UiSelect
							v-model="commitmentStatus"
							:options="[
								{ value: 'open', label: t('dashboard.knowledge.detail.commitmentStatuses.open') },
								{
									value: 'fulfilled',
									label: t('dashboard.knowledge.detail.commitmentStatuses.fulfilled'),
								},
								{
									value: 'cancelled',
									label: t('dashboard.knowledge.detail.commitmentStatuses.cancelled'),
								},
							]"
						/>
						<UiButton
							class="mt-3"
							size="sm"
							:loading="setCommitmentStatus.isLoading.value"
							@click="saveCommitmentStatus"
						>
							{{ t('dashboard.knowledge.detail.saveStatus') }}
						</UiButton>
					</div>

					<!-- Confidence -->
					<div class="rounded-(--radius-card) bg-surface-2 shadow-surface-1 p-5">
						<h3 class="text-sm font-semibold text-text-primary mb-3">
							{{ t('dashboard.knowledge.detail.confidence') }}
						</h3>
						<div class="flex items-center gap-3">
							<UiProgressBar
								class="w-24"
								size="sm"
								:value="entry.confidence * 100"
								:variant="confidenceVariant(entry.confidence)"
								:aria-label="t('dashboard.knowledge.detail.confidence')"
							/>
							<span class="text-sm font-semibold" :class="confidenceColor(entry.confidence)">
								{{ formatConfidence(entry.confidence) }}
							</span>
						</div>
						<p class="text-xs text-text-tertiary mt-2">
							{{ t('dashboard.knowledge.detail.confidenceHint') }}
						</p>
					</div>

					<!-- Source -->
					<div class="rounded-(--radius-card) bg-surface-2 shadow-surface-1 p-5">
						<h3 class="text-sm font-semibold text-text-primary mb-3">
							{{ t('dashboard.knowledge.detail.source') }}
						</h3>
						<div class="flex items-center gap-2">
							<div class="w-8 h-8 rounded-lg bg-bg-surface flex items-center justify-center">
								<Icon :name="sourceIcon(entry.sourceType)" class="w-4 h-4 text-text-secondary" />
							</div>
							<div>
								<p class="text-sm font-medium text-text-primary">
									{{ sourceTypeName(entry.sourceType) }}
								</p>
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
							{{ t('dashboard.knowledge.detail.viewSourceThread') }}
						</NuxtLink>
					</div>

					<!-- Dates -->
					<div class="rounded-(--radius-card) bg-surface-2 shadow-surface-1 p-5">
						<h3 class="text-sm font-semibold text-text-primary mb-3">
							{{ t('dashboard.knowledge.detail.details') }}
						</h3>
						<dl class="space-y-2.5 text-sm">
							<div class="flex justify-between">
								<dt class="text-text-tertiary">{{ t('dashboard.knowledge.detail.created') }}</dt>
								<dd class="text-text-secondary">{{ formattedCreatedAt }}</dd>
							</div>
							<div class="flex justify-between">
								<dt class="text-text-tertiary">{{ t('dashboard.knowledge.detail.updated') }}</dt>
								<dd class="text-text-secondary">{{ formattedUpdatedAt }}</dd>
							</div>
							<div v-if="formattedExpiresAt" class="flex justify-between">
								<dt class="text-text-tertiary">{{ t('dashboard.knowledge.detail.expires') }}</dt>
								<dd :class="formattedExpiresAt.isExpired ? 'text-error' : 'text-text-secondary'">
									{{ formattedExpiresAt.text }}
									<span v-if="formattedExpiresAt.isExpired" class="text-xs">
										{{ t('dashboard.knowledge.detail.expired') }}
									</span>
								</dd>
							</div>
						</dl>
					</div>

					<!-- Linked Contacts -->
					<div
						v-if="entry.contactIds && entry.contactIds.length > 0"
						class="rounded-(--radius-card) bg-surface-2 shadow-surface-1 p-5"
					>
						<h3 class="text-sm font-semibold text-text-primary mb-3">
							{{ t('dashboard.knowledge.detail.linkedContacts') }}
						</h3>
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
				enter-active-class="transition-opacity duration-(--motion-fast)"
				enter-from-class="opacity-0"
				enter-to-class="opacity-100"
				leave-active-class="transition-opacity duration-(--motion-fast-exit)"
				leave-from-class="opacity-100"
				leave-to-class="opacity-0"
			>
				<div
					v-if="showEditForm && entry"
					class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-bg-deep/80"
					@click.self="showEditForm = false"
				>
					<div
						class="w-full max-w-lg bg-bg-elevated border border-border-subtle rounded-xl shadow-lg max-h-[90vh] overflow-y-auto"
					>
						<div
							class="flex items-center justify-between px-5 py-4 border-b border-border-subtle sticky top-0 bg-bg-elevated z-10"
						>
							<h3 class="text-base font-semibold text-text-primary">
								{{ t('dashboard.knowledge.detail.editModalTitle') }}
							</h3>
							<button
								class="w-8 h-8 rounded-lg flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-bg-surface-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
								@click="showEditForm = false"
								:aria-label="t('common.close')"
							>
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
				enter-active-class="duration-(--motion-moderate) ease-spring"
				enter-from-class="opacity-0"
				enter-to-class="opacity-100"
				leave-active-class="duration-(--motion-moderate-exit) ease-exit"
				leave-from-class="opacity-100"
				leave-to-class="opacity-0"
			>
				<div
					v-if="showDeleteConfirm"
					class="fixed inset-0 z-50 flex items-center justify-center p-4"
				>
					<div class="absolute inset-0 bg-bg-deep/80" @click="showDeleteConfirm = false" />
					<div
						class="relative bg-bg-elevated border border-border-subtle rounded-2xl p-6 w-full max-w-sm"
					>
						<h3 class="text-lg font-semibold text-text-primary mb-2">
							{{ t('dashboard.knowledge.detail.deleteModalTitle') }}
						</h3>
						<p class="text-sm text-text-secondary mb-6">
							{{ t('dashboard.knowledge.detail.deleteModalBody') }}
						</p>
						<div class="flex items-center justify-end gap-3">
							<UiButton variant="secondary" @click="showDeleteConfirm = false">
								{{ t('common.cancel') }}
							</UiButton>
							<UiButton variant="danger" :disabled="isDeleting" @click="handleDelete">
								{{ isDeleting ? t('dashboard.knowledge.detail.deleting') : t('common.delete') }}
							</UiButton>
						</div>
					</div>
				</div>
			</Transition>
		</Teleport>
	</div>
</template>
