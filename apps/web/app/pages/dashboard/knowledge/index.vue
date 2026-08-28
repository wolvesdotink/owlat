<script setup lang="ts">
import { api } from '@owlat/api';
import type { EntryType } from '~/utils/knowledgeEntryTypes';

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
	ENTRY_TYPES,
	TYPE_CONFIG,
	typeVariant,
	typeIcon,
} = useKnowledgeGraph();

const showCreateForm = ref(false);
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
}

// Entry-type labels are translated here; the shared presentation map
// (`~/utils/knowledgeEntryTypes`) stays a plain constant, so an unknown type
// still falls back to its raw label instead of a key path.
const entryTypeLabel = (type: EntryType): string => {
	const key = `dashboard.knowledge.index.entryTypes.${type}`;
	return te(key) ? t(key) : TYPE_CONFIG[type].label;
};

const tabs = computed(() => [
	{ key: null as string | null, label: t('common.all'), icon: 'lucide:layers' },
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
	<div class="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
		<!-- Header -->
		<div class="flex items-start justify-between gap-4">
			<div class="flex items-start gap-4">
				<div
					class="w-12 h-12 rounded-xl bg-brand-subtle flex items-center justify-center flex-shrink-0"
				>
					<Icon name="lucide:brain" class="w-6 h-6 text-brand" />
				</div>
				<div>
					<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
						{{ t('dashboard.knowledge.index.title') }}
					</h1>
					<p class="text-sm text-text-secondary mt-0.5">
						{{ t('dashboard.knowledge.index.subtitle') }}
					</p>
				</div>
			</div>
			<UiButton class="gap-2 flex-shrink-0" @click="showCreateForm = true">
				<Icon name="lucide:plus" class="w-4 h-4" />
				{{ t('dashboard.knowledge.index.createEntry') }}
			</UiButton>
		</div>

		<!-- Search Bar -->
		<div class="relative">
			<Icon
				name="lucide:search"
				class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary pointer-events-none"
			/>
			<input
				v-model="searchQuery"
				type="text"
				:placeholder="t('dashboard.knowledge.index.searchPlaceholder')"
				class="input w-full pl-10"
			/>
		</div>

		<!-- Type Tabs -->
		<div class="flex items-center gap-1 overflow-x-auto pb-1 -mb-1">
			<button
				v-for="tab in tabs"
				:key="tab.key ?? 'all'"
				class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors"
				:class="
					(tab.key === null && selectedType === null) || tab.key === selectedType
						? 'bg-brand-subtle text-brand'
						: 'text-text-secondary hover:text-text-primary hover:bg-bg-surface'
				"
				@click="handleTabChange(tab.key)"
			>
				<Icon :name="tab.icon" class="w-3.5 h-3.5" />
				{{ tab.label }}
			</button>
		</div>

		<div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
			<!-- Main Content -->
			<div class="lg:col-span-2 space-y-3">
				<!-- Loading -->
				<div v-if="isLoading" class="flex items-center justify-center py-16">
					<UiSpinner />
				</div>

				<!-- Empty State -->
				<div
					v-else-if="entries.length === 0"
					class="flex flex-col items-center justify-center py-16 text-center"
				>
					<div
						class="w-14 h-14 rounded-full bg-bg-surface border border-border-subtle flex items-center justify-center mb-4"
					>
						<Icon
							:name="searchQuery ? 'lucide:search-x' : 'lucide:brain'"
							class="w-7 h-7 text-text-tertiary"
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
						<Icon name="lucide:plus" class="w-4 h-4" />
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
						:confidence="entry.confidence"
						:tags="entry.tags"
						:source-type="entry.sourceType"
						:created-at="entry.createdAt"
					/>
				</template>
			</div>

			<!-- Sidebar -->
			<div class="space-y-4">
				<div class="rounded-xl border border-border-subtle bg-bg-elevated p-5">
					<h3 class="flex items-center gap-2 text-sm font-semibold text-text-primary">
						<Icon name="lucide:badge-check" class="h-4 w-4 text-brand" />
						{{ t('dashboard.knowledge.index.canonicalAnswers') }}
					</h3>
					<p class="mt-2 text-sm text-text-secondary">
						{{ t('dashboard.knowledge.index.canonicalAnswersBody') }}
					</p>
					<div class="mt-4 space-y-2">
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
						<UiButton
							size="sm"
							:loading="createPolicy.isLoading.value"
							:disabled="!policyTitle.trim() || !policyContent.trim()"
							@click="handleCreatePolicy"
						>
							{{ t('dashboard.knowledge.index.addCanonicalAnswer') }}
						</UiButton>
					</div>
					<ul v-if="policies?.length" class="mt-4 space-y-2 border-t border-border-subtle pt-4">
						<li v-for="policy in policies" :key="policy._id">
							<NuxtLink
								:to="`/dashboard/knowledge/${policy._id}`"
								class="block truncate text-sm font-medium text-text-primary hover:text-brand"
							>
								{{ policy.title }}
							</NuxtLink>
						</li>
					</ul>
				</div>

				<!-- How it works -->
				<div class="rounded-xl border border-border-subtle bg-bg-elevated p-5">
					<h3 class="text-sm font-semibold text-text-primary mb-3 flex items-center gap-2">
						<Icon name="lucide:info" class="w-4 h-4 text-text-tertiary" />
						{{ t('dashboard.knowledge.index.howItWorks') }}
					</h3>
					<div class="space-y-3 text-sm text-text-secondary">
						<div class="flex items-start gap-2.5">
							<div
								class="w-5 h-5 rounded-full bg-brand-subtle text-brand flex items-center justify-center flex-shrink-0 text-xs font-bold mt-0.5"
							>
								1
							</div>
							<p>{{ t('dashboard.knowledge.index.howItWorksStep1') }}</p>
						</div>
						<div class="flex items-start gap-2.5">
							<div
								class="w-5 h-5 rounded-full bg-brand-subtle text-brand flex items-center justify-center flex-shrink-0 text-xs font-bold mt-0.5"
							>
								2
							</div>
							<p>{{ t('dashboard.knowledge.index.howItWorksStep2') }}</p>
						</div>
						<div class="flex items-start gap-2.5">
							<div
								class="w-5 h-5 rounded-full bg-brand-subtle text-brand flex items-center justify-center flex-shrink-0 text-xs font-bold mt-0.5"
							>
								3
							</div>
							<p>{{ t('dashboard.knowledge.index.howItWorksStep3') }}</p>
						</div>
					</div>
				</div>

				<!-- Entry Types Legend -->
				<div class="rounded-xl border border-border-subtle bg-bg-elevated p-5">
					<h3 class="text-sm font-semibold text-text-primary mb-3">
						{{ t('dashboard.knowledge.index.entryTypesTitle') }}
					</h3>
					<div class="space-y-2">
						<div
							v-for="entryType in ENTRY_TYPES"
							:key="entryType"
							class="flex items-center gap-2.5"
						>
							<div
								class="w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0"
								:class="{
									'bg-brand-subtle text-brand': typeVariant(entryType) === 'default',
									'bg-warning/10 text-warning': typeVariant(entryType) === 'warning',
									'bg-bg-surface text-text-secondary': typeVariant(entryType) === 'neutral',
									'bg-success-subtle text-success': typeVariant(entryType) === 'success',
									'bg-error/10 text-error': typeVariant(entryType) === 'error',
								}"
							>
								<Icon :name="typeIcon(entryType)" class="w-3.5 h-3.5" />
							</div>
							<span class="text-sm text-text-secondary">{{ entryTypeLabel(entryType) }}</span>
						</div>
					</div>
				</div>
			</div>
		</div>

		<!-- Create Entry Modal -->
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
					v-if="showCreateForm"
					class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-bg-deep/80"
					@click.self="handleCancelled"
				>
					<Transition
						enter-active-class="transition-all duration-(--motion-moderate)"
						enter-from-class="opacity-0 scale-95"
						enter-to-class="opacity-100 scale-100"
						leave-active-class="transition-all duration-(--motion-moderate-exit)"
						leave-from-class="opacity-100 scale-100"
						leave-to-class="opacity-0 scale-95"
					>
						<div
							v-if="showCreateForm"
							class="w-full max-w-lg bg-bg-elevated border border-border-subtle rounded-xl shadow-lg max-h-[90vh] overflow-y-auto"
						>
							<div
								class="flex items-center justify-between px-5 py-4 border-b border-border-subtle sticky top-0 bg-bg-elevated z-10"
							>
								<h3 class="text-base font-semibold text-text-primary">
									{{ t('dashboard.knowledge.index.createModalTitle') }}
								</h3>
								<button
									class="w-8 h-8 rounded-lg flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-bg-surface-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
									@click="handleCancelled"
									:aria-label="t('common.close')"
								>
									<Icon name="lucide:x" class="w-4 h-4" />
								</button>
							</div>
							<div class="px-5 py-4">
								<KnowledgeEntryForm @saved="handleSaved" @cancelled="handleCancelled" />
							</div>
						</div>
					</Transition>
				</div>
			</Transition>
		</Teleport>
	</div>
</template>
