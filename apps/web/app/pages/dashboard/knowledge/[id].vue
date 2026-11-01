<script setup lang="ts">
import { api } from '@owlat/api';
import { offersShareWithMembers } from '~/utils/knowledgeSharing';
import { useKnowledgeDetailLabels } from '~/composables/useKnowledgeDetailLabels';

const { t, locale } = useI18n();

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
	sourceIcon,
	confidenceColor,
	formatConfidence,
	confidenceVariant,
	deleteEntry,
} = useKnowledgeGraph();

// Fetch entry with relations
const {
	data: entryData,
	isLoading,
	error: entryError,
	refetch: refetchEntry,
} = useOrganizationQuery(api.knowledge.graph.getEntry, () => ({
	entryId: entryId.value,
}));

const entry = computed(() => entryData.value?.entry ?? null);

// A curated answer is admin-authored and quoted to customers; the backend
// refuses a member's edit or delete, so the buttons stay hidden for them.
const { isAdmin } = usePermissions();
const canChangeEntry = computed(() => entry.value?.isAuthoritative !== true || isAdmin.value);
const outgoingRelations = computed(() => entryData.value?.outgoing ?? []);
const incomingRelations = computed(() => entryData.value?.incoming ?? []);

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

// Entry-type / source / relation labels, translated with a raw-label fallback.
const { entryTypeName, sourceTypeName } = useKnowledgeDetailLabels();

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

		<!-- A failed read is not a deleted entry (#721). -->
		<UiQueryBoundary v-if="entryError" :error="entryError" @retry="refetchEntry" />

		<!-- Loading -->
		<DashboardDetailSkeleton v-else-if="isLoading" lead="tile-lg" meta :actions="2" />

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
			<div class="flex items-start gap-4">
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
				<UiPageHeader class="min-w-0 flex-1" :title="entry.title">
					<template #meta>
						<div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
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
							<p class="text-sm text-text-tertiary">
								{{ t('dashboard.knowledge.detail.createdAt', { date: formattedCreatedAt }) }}
							</p>
						</div>
					</template>
					<template v-if="canChangeEntry" #actions>
						<!-- Owner/admin-only knowledge (migration 0069) can be shared again after a review. -->
						<KnowledgeShareWithMembers
							v-if="offersShareWithMembers(entry, isAdmin)"
							:entry-id="entry._id"
						/>
						<UiButton variant="secondary" class="gap-2" @click="showEditForm = true">
							<Icon name="lucide:pencil" class="w-4 h-4" />
							{{ t('common.edit') }}
						</UiButton>
						<UiButton variant="danger-outline" class="gap-2" @click="showDeleteConfirm = true">
							<Icon name="lucide:trash-2" class="w-4 h-4" />
							{{ t('common.delete') }}
						</UiButton>
					</template>
				</UiPageHeader>
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
					<KnowledgeRelationsCard
						:entry-id="entryId"
						:outgoing-relations="outgoingRelations"
						:incoming-relations="incomingRelations"
						:entry-map="entryMap"
					/>
				</div>

				<!-- Sidebar Metadata -->
				<div class="space-y-4">
					<KnowledgeCommitmentStatusCard
						v-if="entry.entryType === 'decision' || entry.entryType === 'action_item'"
						:entry="entry"
					/>

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
					<KnowledgeLinkedContactsCard
						v-if="entry.contactIds && entry.contactIds.length > 0"
						:contact-ids="entry.contactIds"
					/>
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
