<script setup lang="ts">
useHead({ title: 'Knowledge Graph — Owlat' });

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

const tabs = computed(() => [
	{ key: null as string | null, label: 'All', icon: 'lucide:layers' },
	...ENTRY_TYPES.map((t) => ({
		key: t as string | null,
		label: TYPE_CONFIG[t].label,
		icon: TYPE_CONFIG[t].icon,
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
					<h1 class="text-xl font-bold text-text-primary">Knowledge Graph</h1>
					<p class="text-sm text-text-secondary mt-0.5">
						Browse, search, and manage extracted knowledge from your conversations and files.
					</p>
				</div>
			</div>
			<button
				class="btn btn-primary gap-2 flex-shrink-0"
				@click="showCreateForm = true"
			>
				<Icon name="lucide:plus" class="w-4 h-4" />
				Create Entry
			</button>
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
				placeholder="Search knowledge entries..."
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
				<div
					v-if="isLoading"
					class="flex items-center justify-center py-16"
				>
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
						{{ searchQuery ? 'No results found' : 'No entries yet' }}
					</h3>
					<p class="text-sm text-text-secondary mt-1 max-w-sm">
						{{
							searchQuery
								? `No knowledge entries match "${searchQuery}". Try a different search term.`
								: 'Knowledge entries are extracted from conversations and files, or you can create them manually.'
						}}
					</p>
					<button
						v-if="!searchQuery"
						class="mt-4 btn btn-primary gap-2"
						@click="showCreateForm = true"
					>
						<Icon name="lucide:plus" class="w-4 h-4" />
						Create First Entry
					</button>
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
				<!-- How it works -->
				<div class="rounded-xl border border-border-subtle bg-bg-elevated p-5">
					<h3 class="text-sm font-semibold text-text-primary mb-3 flex items-center gap-2">
						<Icon name="lucide:info" class="w-4 h-4 text-text-tertiary" />
						How it works
					</h3>
					<div class="space-y-3 text-sm text-text-secondary">
						<div class="flex items-start gap-2.5">
							<div class="w-5 h-5 rounded-full bg-brand-subtle text-brand flex items-center justify-center flex-shrink-0 text-xs font-bold mt-0.5">1</div>
							<p>Knowledge is automatically extracted from emails, chats, and files by the AI agent.</p>
						</div>
						<div class="flex items-start gap-2.5">
							<div class="w-5 h-5 rounded-full bg-brand-subtle text-brand flex items-center justify-center flex-shrink-0 text-xs font-bold mt-0.5">2</div>
							<p>Each entry has a confidence score that decays over time, with recent use slowing the decay.</p>
						</div>
						<div class="flex items-start gap-2.5">
							<div class="w-5 h-5 rounded-full bg-brand-subtle text-brand flex items-center justify-center flex-shrink-0 text-xs font-bold mt-0.5">3</div>
							<p>Entries are linked to contacts and related to each other, forming a navigable knowledge graph.</p>
						</div>
					</div>
				</div>

				<!-- Entry Types Legend -->
				<div class="rounded-xl border border-border-subtle bg-bg-elevated p-5">
					<h3 class="text-sm font-semibold text-text-primary mb-3">Entry Types</h3>
					<div class="space-y-2">
						<div
							v-for="t in ENTRY_TYPES"
							:key="t"
							class="flex items-center gap-2.5"
						>
							<div
								class="w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0"
								:class="{
									'bg-brand-subtle text-brand': typeVariant(t) === 'default',
									'bg-warning/10 text-warning': typeVariant(t) === 'warning',
									'bg-bg-surface text-text-secondary': typeVariant(t) === 'neutral',
									'bg-success-subtle text-success': typeVariant(t) === 'success',
									'bg-error/10 text-error': typeVariant(t) === 'error',
								}"
							>
								<Icon :name="typeIcon(t)" class="w-3.5 h-3.5" />
							</div>
							<span class="text-sm text-text-secondary">{{ TYPE_CONFIG[t].label }}</span>
						</div>
					</div>
				</div>
			</div>
		</div>

		<!-- Create Entry Modal -->
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
					v-if="showCreateForm"
					class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
					@click.self="handleCancelled"
				>
					<Transition
						enter-active-class="transition-all duration-200"
						enter-from-class="opacity-0 scale-95"
						enter-to-class="opacity-100 scale-100"
						leave-active-class="transition-all duration-150"
						leave-from-class="opacity-100 scale-100"
						leave-to-class="opacity-0 scale-95"
					>
						<div
							v-if="showCreateForm"
							class="w-full max-w-lg bg-bg-elevated border border-border-subtle rounded-xl shadow-xl max-h-[90vh] overflow-y-auto"
						>
							<div class="flex items-center justify-between px-5 py-4 border-b border-border-subtle sticky top-0 bg-bg-elevated z-10">
								<h3 class="text-base font-semibold text-text-primary">Create Knowledge Entry</h3>
								<button
									class="w-8 h-8 rounded-lg flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-bg-surface transition-colors"
									@click="handleCancelled"
								 aria-label="Close">
									<Icon name="lucide:x" class="w-4 h-4" />
								</button>
							</div>
							<div class="px-5 py-4">
								<KnowledgeEntryForm
									@saved="handleSaved"
									@cancelled="handleCancelled"
								/>
							</div>
						</div>
					</Transition>
				</div>
			</Transition>
		</Teleport>
	</div>
</template>
