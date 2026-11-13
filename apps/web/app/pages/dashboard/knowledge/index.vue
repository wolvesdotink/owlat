<script setup lang="ts">
import { api } from '@owlat/api';
import type { EntryType } from '~/utils/knowledgeEntryTypes';
import {
	BrainIcon,
	LayersIcon,
	ShareAltIcon,
	PlusIcon,
	SearchCloseIcon,
	SearchIcon,
	WavyCheckIcon,
} from '@coolicons/vue';

const { t, te } = useI18n();

useHead({ title: () => t('dashboard.knowledge.index.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const {
	searchQuery,
	selectedType,
	entries,
	isLoading,
	error: entriesError,
	refetch: refetchEntries,
	ENTRY_TYPES,
	TYPE_CONFIG,
	typeVariant,
	typeIcon,
} = useKnowledgeGraph();

const showCreateForm = ref(false);
const { isEnabled } = useFeatureFlag();
const graphEnabled = computed(() => isEnabled('ai.knowledge.analytics'));
// Secondary detail on a browsing page: the canonical-answer form and the
// how-it-works guide each open on demand.
const showPolicyForm = ref(false);
const showGuide = ref(false);
// Curated answers are admin-authored (knowledge.graph.createPolicyEntry);
// members read them but do not see the form.
const { isAdmin } = usePermissions();
const policyTitle = ref('');
const policyContent = ref('');
const { data: policies } = useConvexQuery(api.knowledge.graph.listPolicies, () => ({ limit: 10 }));
const createPolicy = useBackendOperation(api.knowledge.graph.createPolicyEntry, {
	label: () => t('dashboard.knowledge.index.createPolicyOperation'),
});

async function handleCreatePolicy() {
	const title = policyTitle.value.trim();
	const content = policyContent.value.trim();
	if (!title || !content) return;
	const result = await createPolicy.run({ title, content, entryType: 'faq' });
	if (!result.ok) return;
	policyTitle.value = '';
	policyContent.value = '';
	showPolicyForm.value = false;
}

// Entry-type labels are translated here; the shared presentation map
// (`~/utils/knowledgeEntryTypes`) stays a plain constant, so an unknown type
// still falls back to its raw label instead of a key path.
const entryTypeLabel = (type: EntryType): string => {
	const key = `dashboard.knowledge.index.entryTypes.${type}`;
	return te(key) ? t(key) : TYPE_CONFIG[type].label;
};

const tabs = computed(() => [
	{ key: null as string | null, label: t('common.all'), icon: LayersIcon },
	...ENTRY_TYPES.map((entryType) => ({
		key: entryType as string | null,
		label: entryTypeLabel(entryType),
		icon: TYPE_CONFIG[entryType].icon,
	})),
]);

const handleTabChange = (key: string | null) => {
	selectedType.value = key as typeof selectedType.value;
};

const handleSaved = (id: string) => {
	showCreateForm.value = false;
	navigateTo(`/dashboard/knowledge/${id}`);
};

const handleCancelled = () => {
	showCreateForm.value = false;
};
</script>

<template>
	<div class="mx-auto w-full max-w-page p-6 lg:p-8 space-y-6">
		<UiPageHeader
			:title="t('dashboard.knowledge.index.title')"
			:description="t('dashboard.knowledge.index.subtitle')"
		>
			<template #actions>
				<UiButton
					v-if="graphEnabled"
					variant="secondary"
					class="gap-2"
					to="/dashboard/knowledge/graph"
				>
					<ShareAltIcon class="w-4 h-4" aria-hidden="true" />
					{{ t('dashboard.knowledge.index.graphView') }}
				</UiButton>
				<UiButton class="gap-2" @click="showCreateForm = true">
					<PlusIcon class="w-4 h-4" />
					{{ t('dashboard.knowledge.index.createEntry') }}
				</UiButton>
			</template>
		</UiPageHeader>

		<!-- Search Bar -->
		<div class="relative">
			<SearchIcon
				class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary pointer-events-none"
			/>
			<input
				v-model="searchQuery"
				type="search"
				:placeholder="t('dashboard.knowledge.index.searchPlaceholder')"
				:aria-label="t('dashboard.knowledge.index.searchPlaceholder')"
				class="input w-full pl-10"
			/>
		</div>

		<!-- Type Tabs -->
		<div class="flex items-center gap-1 overflow-x-auto pb-1 -mb-1">
			<button
				v-for="tab in tabs"
				:key="tab.key ?? 'all'"
				type="button"
				:aria-pressed="(tab.key === null && selectedType === null) || tab.key === selectedType"
				class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors"
				:class="
					(tab.key === null && selectedType === null) || tab.key === selectedType
						? 'bg-brand-subtle text-brand'
						: 'text-text-secondary hover:text-text-primary hover:bg-bg-surface'
				"
				@click="handleTabChange(tab.key)"
			>
				<component :is="tab.icon" class="w-3.5 h-3.5" aria-hidden="true" />
				{{ tab.label }}
			</button>
		</div>

		<div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
			<!-- Main Content -->
			<div class="lg:col-span-2 space-y-3">
				<!-- A failed read is not an empty knowledge base. -->
				<UiQueryBoundary
					v-if="entriesError"
					:error="entriesError"
					:error-title="t('dashboard.knowledge.index.loadError')"
					@retry="refetchEntries"
				/>

				<!-- Loading -->
				<KnowledgeEntryListSkeleton v-else-if="isLoading" />

				<!-- Empty State -->
				<div
					v-else-if="entries.length === 0"
					class="flex flex-col items-center justify-center py-16 text-center"
				>
					<div
						class="w-14 h-14 rounded-full bg-bg-surface border border-border-subtle flex items-center justify-center mb-4"
					>
						<component
							:is="searchQuery ? SearchCloseIcon : BrainIcon"
							class="w-7 h-7 text-text-tertiary"
							:stroke-width="1.5"
						/>
					</div>
					<h3 class="text-base font-medium text-text-primary">
						{{
							searchQuery
								? t('dashboard.knowledge.index.noResultsTitle')
								: t('dashboard.knowledge.index.emptyTitle')
						}}
					</h3>
					<p class="text-sm text-text-secondary mt-1 max-w-sm">
						{{
							searchQuery
								? t('dashboard.knowledge.index.noResultsBody', { query: searchQuery })
								: t('dashboard.knowledge.index.emptyBody')
						}}
					</p>
					<UiButton v-if="!searchQuery" class="mt-4 gap-2" @click="showCreateForm = true">
						<PlusIcon class="w-4 h-4" />
						{{ t('dashboard.knowledge.index.createFirstEntry') }}
					</UiButton>
				</div>

				<!-- Entry List -->
				<template v-else>
					<KnowledgeEntryCard
						v-for="entry in entries"
						:key="entry._id"
						:id="entry._id"
						:entry-type="entry.entryType"
						:title="entry.title"
						:content="entry.content"
						:tags="entry.tags"
						:created-at="entry.createdAt"
					/>
				</template>
			</div>

			<!-- Sidebar -->
			<div class="space-y-4">
				<div class="rounded-(--radius-card) bg-surface-2 shadow-surface-1 p-5">
					<h3 class="flex items-center gap-2 text-sm font-semibold text-text-primary">
						<WavyCheckIcon class="h-4 w-4 text-brand" />
						{{ t('dashboard.knowledge.index.canonicalAnswers') }}
					</h3>
					<p class="mt-2 text-sm text-text-secondary">
						{{ t('dashboard.knowledge.index.canonicalAnswersBody') }}
					</p>
					<UiButton
						v-if="isAdmin && !showPolicyForm"
						variant="secondary"
						size="sm"
						class="mt-4 gap-1.5"
						@click="showPolicyForm = true"
					>
						<PlusIcon class="w-3.5 h-3.5" aria-hidden="true" />
						{{ t('dashboard.knowledge.index.addCanonicalAnswer') }}
					</UiButton>
					<div v-if="isAdmin && showPolicyForm" class="mt-4 space-y-2">
						<UiInput
							v-model="policyTitle"
							:label="t('dashboard.knowledge.index.questionLabel')"
							:placeholder="t('dashboard.knowledge.index.questionPlaceholder')"
						/>
						<UiTextarea
							v-model="policyContent"
							:label="t('dashboard.knowledge.index.answerLabel')"
							:rows="3"
						/>
						<div class="flex items-center gap-2">
							<UiButton
								size="sm"
								:loading="createPolicy.isLoading.value"
								:disabled="!policyTitle.trim() || !policyContent.trim()"
								@click="handleCreatePolicy"
							>
								{{ t('dashboard.knowledge.index.addCanonicalAnswer') }}
							</UiButton>
							<UiButton variant="ghost" size="sm" @click="showPolicyForm = false">
								{{ t('common.cancel') }}
							</UiButton>
						</div>
					</div>
					<ul v-if="policies?.length" class="mt-4 space-y-2 border-t border-border-subtle pt-4">
						<li v-for="policy in policies" :key="policy._id">
							<!-- native-title: the full title of a canonical answer the link truncates -->
							<NuxtLink
								:to="`/dashboard/knowledge/${policy._id}`"
								class="block truncate text-sm font-medium text-text-primary hover:text-brand"
								:title="policy.title"
							>
								{{ policy.title }}
							</NuxtLink>
						</li>
					</ul>
				</div>

				<!-- How it works + entry types, collapsed by default -->
				<div class="rounded-(--radius-card) bg-surface-2 shadow-surface-1 p-5">
					<UiDisclosure v-model="showGuide" :label="t('dashboard.knowledge.index.howItWorks')">
						<ol class="space-y-3 text-sm text-text-secondary">
							<li class="flex items-start gap-2.5">
								<span
									class="w-5 h-5 rounded-full bg-brand-subtle text-brand flex items-center justify-center flex-shrink-0 text-xs font-bold mt-0.5"
									aria-hidden="true"
								>
									1
								</span>
								<p>{{ t('dashboard.knowledge.index.howItWorksStep1') }}</p>
							</li>
							<li class="flex items-start gap-2.5">
								<span
									class="w-5 h-5 rounded-full bg-brand-subtle text-brand flex items-center justify-center flex-shrink-0 text-xs font-bold mt-0.5"
									aria-hidden="true"
								>
									2
								</span>
								<p>{{ t('dashboard.knowledge.index.howItWorksStep2') }}</p>
							</li>
							<li class="flex items-start gap-2.5">
								<span
									class="w-5 h-5 rounded-full bg-brand-subtle text-brand flex items-center justify-center flex-shrink-0 text-xs font-bold mt-0.5"
									aria-hidden="true"
								>
									3
								</span>
								<p>{{ t('dashboard.knowledge.index.howItWorksStep3') }}</p>
							</li>
						</ol>
						<h4 class="text-sm font-semibold text-text-primary mt-5 mb-3">
							{{ t('dashboard.knowledge.index.entryTypesTitle') }}
						</h4>
						<ul class="space-y-2">
							<li
								v-for="entryType in ENTRY_TYPES"
								:key="entryType"
								class="flex items-center gap-2.5"
							>
								<span
									class="w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0"
									:class="{
										'bg-brand-subtle text-brand': typeVariant(entryType) === 'default',
										'bg-warning/10 text-warning': typeVariant(entryType) === 'warning',
										'bg-bg-surface text-text-secondary': typeVariant(entryType) === 'neutral',
										'bg-success-subtle text-success': typeVariant(entryType) === 'success',
										'bg-error/10 text-error': typeVariant(entryType) === 'error',
									}"
									aria-hidden="true"
								>
									<component :is="typeIcon(entryType)" class="w-3.5 h-3.5" />
								</span>
								<span class="text-sm text-text-secondary">{{ entryTypeLabel(entryType) }}</span>
							</li>
						</ul>
					</UiDisclosure>
				</div>
			</div>
		</div>

		<!-- Create Entry Modal -->
		<UiModal
			:open="showCreateForm"
			:title="t('dashboard.knowledge.index.createModalTitle')"
			size="lg"
			@update:open="showCreateForm = $event"
		>
			<KnowledgeEntryForm @saved="handleSaved" @cancelled="handleCancelled" />
		</UiModal>
	</div>
</template>
