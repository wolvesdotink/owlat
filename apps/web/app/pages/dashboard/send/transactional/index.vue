<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import { languageOptions, formatLanguageLabel } from '~/data/languageOptions';

const { t } = useI18n();

useHead({ title: () => t('dashboard.send.transactional.index.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const { hasActiveOrganization, isLoading: teamLoading } = useOrganizationContext();

const {
	selectedStatus,
	viewMode,
	searchQuery,
	debouncedSearch,
	currentSort,
	isSortDropdownOpen,
	selectSort,
	statusFilters,
	sortOptions,
	transactionalEmails,
	statusCounts,
	sendCounts,
	isLoading: listLoading,
	error: emailsError,
	dropdownOpenStates,
	formatDate,
	getStatusBadge,
	handleDuplicate,
	isDeleteModalOpen,
	emailToDelete,
	isDeleting,
	openDeleteModal,
	closeDeleteModal,
	handleDelete,
	isCreateModalOpen,
	createForm,
	createFormErrors,
	createError,
	isCreating,
	openCreateModal,
	closeCreateModal,
	handleCreate,
	handleEdit,
	isCodeSnippetModalOpen,
	selectedEmailForCode,
	copiedSnippet,
	openCodeSnippetModal,
	closeCodeSnippetModal,
	getCodeSnippet,
	copyToClipboard,
} = useTransactionalList();

// Recent-sends modal (links through to the per-send delivery timeline)
const recentSendsEmailId = ref<Id<'transactionalEmails'> | null>(null);
const recentSendsEmailName = ref('');
const isRecentSendsOpen = ref(false);
function openRecentSends(id: Id<'transactionalEmails'>, name: string) {
	recentSendsEmailId.value = id;
	recentSendsEmailName.value = name;
	isRecentSendsOpen.value = true;
}

const isLoading = computed(() => teamLoading.value || listLoading.value);
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
			<div>
				<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
					{{ t('dashboard.send.transactional.index.title') }}
				</h1>
				<p class="mt-1 text-text-secondary">
					{{ t('dashboard.send.transactional.index.subtitle') }}
				</p>
			</div>
			<UiButton size="sm" @click="openCreateModal">
				<template #iconLeft>
					<Icon name="lucide:plus" class="w-4 h-4" />
				</template>
				{{ t('dashboard.send.transactional.index.newEmail') }}
			</UiButton>
		</div>

		<!-- Filters and Search -->
		<div class="flex flex-col sm:flex-row sm:items-center gap-4 mb-6">
			<!-- Status Filters -->
			<div class="flex items-center gap-1 p-1 bg-bg-surface rounded-lg">
				<button
					v-for="filter in statusFilters"
					:key="filter.value"
					:class="[
						'px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-1.5',
						selectedStatus === filter.value
							? 'bg-bg-elevated text-text-primary shadow-sm'
							: 'text-text-secondary hover:text-text-primary',
					]"
					@click="selectedStatus = filter.value"
				>
					{{ t(filter.label) }}
					<span v-if="statusCounts" class="text-xs text-text-tertiary">
						({{ filter.value === 'all' ? statusCounts.total : statusCounts[filter.value] }})
					</span>
				</button>
			</div>

			<div class="flex-1" />

			<!-- Search, Sort, and View Toggle -->
			<div class="flex items-center gap-3">
				<UiInput
					v-model="searchQuery"
					type="text"
					:placeholder="t('dashboard.send.transactional.index.searchPlaceholder')"
					size="sm"
					class="w-64"
				>
					<template #iconLeft>
						<Icon name="lucide:search" class="w-4 h-4 text-text-tertiary" />
					</template>
				</UiInput>

				<!-- Sort Dropdown -->
				<div class="relative" data-sort-dropdown>
					<UiButton
						variant="outline"
						size="sm"
						aria-haspopup="listbox"
						:aria-expanded="isSortDropdownOpen"
						aria-controls="transactional-sort-listbox"
						:aria-label="t('dashboard.send.transactional.index.sortLabel')"
						@click="isSortDropdownOpen = !isSortDropdownOpen"
					>
						<template #iconLeft>
							<Icon name="lucide:arrow-up-down" class="w-4 h-4" />
						</template>
						<span class="hidden sm:inline">{{ t(currentSort.label) }}</span>
						<template #iconRight>
							<Icon name="lucide:chevron-down" class="w-4 h-4" />
						</template>
					</UiButton>
					<Transition
						enter-active-class="duration-(--motion-moderate) ease-spring"
						enter-from-class="opacity-0 scale-95"
						enter-to-class="opacity-100 scale-100"
						leave-active-class="duration-(--motion-moderate-exit) ease-exit"
						leave-from-class="opacity-100 scale-100"
						leave-to-class="opacity-0 scale-95"
					>
						<div
							v-if="isSortDropdownOpen"
							id="transactional-sort-listbox"
							role="listbox"
							:aria-label="t('dashboard.send.transactional.index.sortLabel')"
							class="absolute right-0 top-full mt-1 w-44 bg-bg-elevated border border-border-subtle rounded-lg shadow-lg z-20 py-1"
						>
							<button
								v-for="option in sortOptions"
								:key="option.value"
								role="option"
								:aria-selected="currentSort.value === option.value"
								:class="[
									'w-full px-3 py-2 text-left text-sm transition-colors flex items-center justify-between focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset',
									currentSort.value === option.value
										? 'text-brand bg-brand/5'
										: 'text-text-primary hover:bg-bg-surface',
								]"
								@click="selectSort(option)"
							>
								{{ t(option.label) }}
								<Icon
									v-if="currentSort.value === option.value"
									name="lucide:check"
									class="w-4 h-4"
								/>
							</button>
						</div>
					</Transition>
				</div>

				<!-- View Mode Toggle -->
				<div class="flex items-center gap-1 p-1 bg-bg-surface rounded-lg">
					<button
						:class="[
							'p-2 rounded-md transition-colors',
							viewMode === 'grid'
								? 'bg-bg-elevated text-text-primary shadow-sm'
								: 'text-text-tertiary hover:text-text-primary',
						]"
						@click="viewMode = 'grid'"
						:aria-label="t('dashboard.send.transactional.index.gridView')"
					>
						<Icon name="lucide:grid-3x3" class="w-4 h-4" />
					</button>
					<button
						:class="[
							'p-2 rounded-md transition-colors',
							viewMode === 'list'
								? 'bg-bg-elevated text-text-primary shadow-sm'
								: 'text-text-tertiary hover:text-text-primary',
						]"
						@click="viewMode = 'list'"
						:aria-label="t('dashboard.send.transactional.index.listView')"
					>
						<Icon name="lucide:list" class="w-4 h-4" />
					</button>
				</div>
			</div>
		</div>

		<!-- Content -->
		<div>
			<UiQueryBoundary
				:loading="isLoading && !transactionalEmails"
				:error="emailsError"
				:error-title="t('dashboard.send.transactional.index.loadError')"
				:loading-label="t('dashboard.send.transactional.index.loadingEmails')"
			>
				<!-- Empty State (no organization) -->
				<UiEmptyState
					v-if="!hasActiveOrganization"
					icon="lucide:send"
					:title="t('dashboard.send.transactional.index.emptyNoWorkspace.title')"
					:description="t('dashboard.send.transactional.index.emptyNoWorkspace.description')"
				/>

				<!-- Empty State (no transactional emails) -->
				<UiEmptyState
					v-else-if="
						!isLoading &&
						(!transactionalEmails || transactionalEmails.length === 0) &&
						!debouncedSearch
					"
					icon="lucide:send"
					:title="t('dashboard.send.transactional.index.empty.title')"
					:description="t('dashboard.send.transactional.index.empty.description')"
				>
					<template #action>
						<UiButton @click="openCreateModal">
							<template #iconLeft>
								<Icon name="lucide:plus" class="w-4 h-4" />
							</template>
							{{ t('dashboard.send.transactional.index.empty.action') }}
						</UiButton>
					</template>
				</UiEmptyState>

				<!-- Empty State (no search results) -->
				<UiEmptyState
					v-else-if="
						!isLoading &&
						(!transactionalEmails || transactionalEmails.length === 0) &&
						debouncedSearch
					"
					icon="lucide:search"
					:title="t('dashboard.send.transactional.index.noResults.title')"
					:description="
						t('dashboard.send.transactional.index.noResults.description', {
							query: debouncedSearch,
						})
					"
				>
					<template #action>
						<UiButton
							variant="secondary"
							@click="
								searchQuery = '';
								debouncedSearch = '';
							"
						>
							{{ t('dashboard.send.transactional.index.clearSearch') }}
						</UiButton>
					</template>
				</UiEmptyState>

				<!-- Grid View -->
				<div
					v-else-if="viewMode === 'grid'"
					class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4"
				>
					<UiCard
						v-for="email in transactionalEmails"
						:key="email._id"
						padding="none"
						overflow="hidden"
						hoverable
						clickable
						class="group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
						role="button"
						tabindex="0"
						:aria-label="
							t('dashboard.send.transactional.index.editAriaLabel', { name: email.name })
						"
						@click="handleEdit(email._id)"
						@keydown.enter.self="handleEdit(email._id)"
						@keydown.space.self.prevent="handleEdit(email._id)"
					>
						<!-- Thumbnail Area -->
						<div
							class="aspect-[4/3] bg-bg-surface flex flex-col items-center justify-center relative px-4"
						>
							<Icon name="lucide:send" class="w-10 h-10 text-text-tertiary/30 mb-2" />
							<code
								class="px-2 py-1 rounded bg-bg-elevated text-text-tertiary text-xs font-mono truncate max-w-full"
							>
								{{ email.slug }}
							</code>
							<!-- Hover Overlay -->
							<div
								class="absolute inset-0 bg-bg-deep/80 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2"
							>
								<button
									class="p-2 rounded-lg bg-bg-elevated text-text-primary hover:bg-bg-surface-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
									:title="t('dashboard.send.transactional.index.viewApiCode')"
									:aria-label="t('dashboard.send.transactional.index.viewApiCode')"
									@click.stop="openCodeSnippetModal(email._id, email.name, email.slug)"
								>
									<Icon name="lucide:code" class="w-4 h-4" />
								</button>
								<button
									class="p-2 rounded-lg bg-bg-elevated text-text-primary hover:bg-bg-surface-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
									@click.stop="handleEdit(email._id)"
									:aria-label="t('common.edit')"
								>
									<Icon name="lucide:pencil" class="w-4 h-4" />
								</button>
								<button
									class="p-2 rounded-lg bg-bg-elevated text-text-primary hover:bg-bg-surface-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
									@click.stop="handleDuplicate(email._id)"
									:aria-label="t('common.copy')"
								>
									<Icon name="lucide:copy" class="w-4 h-4" />
								</button>
								<button
									class="p-2 rounded-lg bg-bg-elevated text-text-primary hover:bg-error hover:text-text-inverse transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
									@click.stop="openDeleteModal(email._id, email.name)"
									:aria-label="t('common.delete')"
								>
									<Icon name="lucide:trash-2" class="w-4 h-4" />
								</button>
							</div>
						</div>

						<!-- Info -->
						<div class="p-4">
							<div class="flex items-start justify-between gap-2">
								<div class="min-w-0 flex-1">
									<h3 class="font-medium text-text-primary truncate">{{ email.name }}</h3>
									<p class="text-sm text-text-tertiary truncate mt-0.5">
										{{ email.subject || t('dashboard.send.transactional.index.noSubject') }}
									</p>
								</div>
								<!-- Dropdown Menu -->
								<UiDropdownMenu v-model:open="dropdownOpenStates[email._id]" @click.stop>
									<template #trigger>
										<UiButton variant="ghost" size="sm">
											<Icon name="lucide:more-vertical" class="w-4 h-4" />
										</UiButton>
									</template>
									<UiDropdownMenuItem
										icon="lucide:code"
										@click="openCodeSnippetModal(email._id, email.name, email.slug)"
									>
										{{ t('dashboard.send.transactional.index.viewApiCode') }}
									</UiDropdownMenuItem>
									<UiDropdownMenuItem
										icon="lucide:send"
										@click="openRecentSends(email._id, email.name)"
									>
										{{ t('dashboard.send.transactional.index.viewSends') }}
									</UiDropdownMenuItem>
									<UiDropdownMenuItem icon="lucide:pencil" @click="handleEdit(email._id)">
										{{ t('common.edit') }}
									</UiDropdownMenuItem>
									<UiDropdownMenuItem icon="lucide:copy" @click="handleDuplicate(email._id)">
										{{ t('common.duplicate') }}
									</UiDropdownMenuItem>
									<UiDropdownDivider />
									<UiDropdownMenuItem
										icon="lucide:trash-2"
										danger
										@click="openDeleteModal(email._id, email.name)"
									>
										{{ t('common.delete') }}
									</UiDropdownMenuItem>
								</UiDropdownMenu>
							</div>

							<!-- Meta Info -->
							<div class="flex items-center gap-2 mt-3">
								<span
									:class="[
										'inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium',
										getStatusBadge(email.status).color,
									]"
								>
									<Icon :name="getStatusBadge(email.status).icon" class="w-3 h-3" />
									{{ t(getStatusBadge(email.status).label) }}
								</span>
								<span class="text-text-tertiary text-xs">
									{{
										t('dashboard.send.transactional.index.sendCount', {
											count: sendCounts?.[email._id] ?? 0,
										})
									}}
								</span>
							</div>

							<p class="text-xs text-text-tertiary mt-3">
								{{
									t('dashboard.send.transactional.index.updatedAt', {
										date: formatDate(email.updatedAt),
									})
								}}
							</p>
						</div>
					</UiCard>
				</div>

				<!-- List View (Table) -->
				<UiCard v-else padding="none" overflow="hidden">
					<div class="overflow-x-auto">
						<table class="w-full">
							<thead>
								<tr class="border-b border-border-subtle">
									<th class="text-left px-6 py-4 text-sm font-medium text-text-secondary">
										{{ t('common.name') }}
									</th>
									<th class="text-left px-6 py-4 text-sm font-medium text-text-secondary">
										{{ t('dashboard.send.transactional.index.columns.slug') }}
									</th>
									<th class="text-left px-6 py-4 text-sm font-medium text-text-secondary">
										{{ t('common.status') }}
									</th>
									<th class="text-left px-6 py-4 text-sm font-medium text-text-secondary">
										{{ t('dashboard.send.transactional.index.columns.sends') }}
									</th>
									<th class="text-left px-6 py-4 text-sm font-medium text-text-secondary">
										{{ t('dashboard.send.transactional.index.columns.updated') }}
									</th>
									<th class="text-right px-6 py-4 text-sm font-medium text-text-secondary">
										{{ t('common.actions') }}
									</th>
								</tr>
							</thead>
							<tbody>
								<tr
									v-for="email in transactionalEmails"
									:key="email._id"
									class="border-b border-border-subtle last:border-b-0 hover:bg-bg-surface transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset"
									role="button"
									tabindex="0"
									:aria-label="
										t('dashboard.send.transactional.index.editAriaLabel', { name: email.name })
									"
									@click="handleEdit(email._id)"
									@keydown.enter.self="handleEdit(email._id)"
									@keydown.space.self.prevent="handleEdit(email._id)"
								>
									<td class="px-6 py-4">
										<div class="flex flex-col">
											<span class="text-text-primary font-medium">{{ email.name }}</span>
											<span class="text-text-tertiary text-sm">{{
												email.subject || t('dashboard.send.transactional.index.noSubject')
											}}</span>
										</div>
									</td>
									<td class="px-6 py-4">
										<code
											class="px-2 py-1 rounded bg-bg-surface text-text-secondary text-sm font-mono"
										>
											{{ email.slug }}
										</code>
									</td>
									<td class="px-6 py-4">
										<span
											:class="[
												'inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium',
												getStatusBadge(email.status).color,
											]"
										>
											<Icon :name="getStatusBadge(email.status).icon" class="w-3 h-3" />
											{{ t(getStatusBadge(email.status).label) }}
										</span>
									</td>
									<td class="px-6 py-4">
										<span class="text-text-secondary text-sm">
											{{ sendCounts?.[email._id] ?? 0 }}
										</span>
									</td>
									<td class="px-6 py-4">
										<span class="text-text-tertiary text-sm">{{
											formatDate(email.updatedAt)
										}}</span>
									</td>
									<td class="px-6 py-4">
										<div class="flex items-center justify-end gap-1" @click.stop>
											<button
												class="p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-surface-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
												:title="t('dashboard.send.transactional.index.viewApiCode')"
												:aria-label="t('dashboard.send.transactional.index.viewApiCode')"
												@click="openCodeSnippetModal(email._id, email.name, email.slug)"
											>
												<Icon name="lucide:code" class="w-4 h-4" />
											</button>
											<button
												class="p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-surface-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
												:title="t('common.edit')"
												:aria-label="t('common.edit')"
												@click="handleEdit(email._id)"
											>
												<Icon name="lucide:pencil" class="w-4 h-4" />
											</button>
											<UiDropdownMenu v-model:open="dropdownOpenStates[email._id]">
												<template #trigger>
													<button
														class="p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-surface-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
														:aria-label="t('dashboard.send.transactional.index.moreActions')"
													>
														<Icon name="lucide:more-vertical" class="w-4 h-4" />
													</button>
												</template>
												<UiDropdownMenuItem
													icon="lucide:code"
													@click="openCodeSnippetModal(email._id, email.name, email.slug)"
												>
													{{ t('dashboard.send.transactional.index.viewApiCode') }}
												</UiDropdownMenuItem>
												<UiDropdownMenuItem
													icon="lucide:send"
													@click="openRecentSends(email._id, email.name)"
												>
													{{ t('dashboard.send.transactional.index.viewSends') }}
												</UiDropdownMenuItem>
												<UiDropdownMenuItem icon="lucide:copy" @click="handleDuplicate(email._id)">
													{{ t('common.duplicate') }}
												</UiDropdownMenuItem>
												<UiDropdownDivider />
												<UiDropdownMenuItem
													icon="lucide:trash-2"
													danger
													@click="openDeleteModal(email._id, email.name)"
												>
													{{ t('common.delete') }}
												</UiDropdownMenuItem>
											</UiDropdownMenu>
										</div>
									</td>
								</tr>
							</tbody>
						</table>
					</div>
				</UiCard>
			</UiQueryBoundary>
		</div>

		<!-- Create Modal -->
		<UiModal
			v-model:open="isCreateModalOpen"
			:title="t('dashboard.send.transactional.index.create.title')"
			:persistent="isCreating"
		>
			<form @submit.prevent="handleCreate">
				<!-- Error -->
				<div
					v-if="createError"
					class="mb-4 p-3 rounded-lg bg-error-subtle border border-error/20 flex items-start gap-3"
				>
					<Icon name="lucide:alert-circle" class="w-5 h-5 text-error shrink-0 mt-0.5" />
					<p class="text-sm text-error">{{ createError }}</p>
				</div>

				<!-- Name Field -->
				<UiInput
					id="email-name"
					v-model="createForm.name"
					:label="t('common.name')"
					required
					:placeholder="t('dashboard.send.transactional.index.create.namePlaceholder')"
					:error="createFormErrors.name"
					:disabled="isCreating"
					class="mb-4"
				/>

				<!-- Slug Field -->
				<UiInput
					id="email-slug"
					v-model="createForm.slug"
					:label="t('dashboard.send.transactional.index.create.slugLabel')"
					required
					:placeholder="t('dashboard.send.transactional.index.create.slugPlaceholder')"
					:error="createFormErrors.slug"
					:help-text="
						!createFormErrors.slug
							? t('dashboard.send.transactional.index.create.slugHelp')
							: undefined
					"
					:disabled="isCreating"
					class="mb-4 font-mono"
				/>

				<!-- Default Language — the language the body you author here is
				     treated as. A non-English deployment can author the template in
				     German and mark German as the default so language resolution and
				     the Translation Manager anchor to the right source. -->
				<UiSelect
					v-model="createForm.defaultLanguage"
					:label="t('dashboard.send.transactional.index.create.defaultLanguage')"
					:options="
						languageOptions.map((l) => ({
							value: l.value,
							label: formatLanguageLabel({ label: t(l.label), nativeLabel: l.nativeLabel }),
						}))
					"
					:disabled="isCreating"
					class="mb-6"
				/>
			</form>

			<template #footer>
				<UiButton variant="secondary" :disabled="isCreating" @click="closeCreateModal">
					{{ t('common.cancel') }}
				</UiButton>
				<UiButton :loading="isCreating" @click="handleCreate">
					{{
						isCreating
							? t('dashboard.send.transactional.index.create.creating')
							: t('dashboard.send.transactional.index.create.submit')
					}}
				</UiButton>
			</template>
		</UiModal>

		<!-- Delete Confirmation Modal -->
		<UiModal
			v-model:open="isDeleteModalOpen"
			:title="t('dashboard.send.transactional.index.delete.title')"
			:persistent="isDeleting"
		>
			<div class="flex items-start gap-4">
				<div class="p-3 rounded-full bg-error/10 shrink-0 flex items-center justify-center">
					<Icon name="lucide:trash-2" class="w-6 h-6 text-error" />
				</div>
				<div>
					<I18nT
						keypath="dashboard.send.transactional.index.delete.confirm"
						tag="p"
						class="text-text-primary"
						scope="global"
					>
						<template #name>
							<span class="font-semibold">"{{ emailToDelete?.name }}"</span>
						</template>
					</I18nT>
					<p class="text-sm text-text-secondary mt-2">
						{{ t('dashboard.send.transactional.index.delete.description') }}
					</p>
				</div>
			</div>

			<template #footer>
				<UiButton variant="secondary" :disabled="isDeleting" @click="closeDeleteModal">
					{{ t('common.cancel') }}
				</UiButton>
				<UiButton variant="danger" :loading="isDeleting" @click="handleDelete">
					{{
						isDeleting
							? t('dashboard.send.transactional.index.delete.deleting')
							: t('common.delete')
					}}
				</UiButton>
			</template>
		</UiModal>

		<!-- Code Snippet Modal -->
		<Teleport to="body">
			<Transition name="modal">
				<div
					v-if="isCodeSnippetModalOpen"
					class="fixed inset-0 z-50 flex items-center justify-center"
				>
					<!-- Backdrop -->
					<div
						class="absolute inset-0 bg-bg-deep/80 backdrop-blur-sm"
						@click="closeCodeSnippetModal"
					/>

					<!-- Modal Content -->
					<div
						class="relative z-10 w-full max-w-2xl mx-4 bg-bg-elevated border border-border-subtle rounded-2xl shadow-lg"
					>
						<!-- Header -->
						<div class="flex items-center justify-between px-6 py-4 border-b border-border-subtle">
							<div>
								<h2 class="text-lg font-semibold text-text-primary">
									{{ t('dashboard.send.transactional.index.apiUsage.title') }}
								</h2>
								<p class="text-sm text-text-secondary mt-0.5">
									{{
										t('dashboard.send.transactional.index.apiUsage.subtitle', {
											name: selectedEmailForCode?.name,
										})
									}}
								</p>
							</div>
							<button
								class="p-1 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-surface-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
								@click="closeCodeSnippetModal"
								:aria-label="t('common.close')"
							>
								<Icon name="lucide:x" class="w-5 h-5" />
							</button>
						</div>

						<!-- Content -->
						<div class="p-6 space-y-4 max-h-[70vh] overflow-y-auto">
							<!-- cURL -->
							<div>
								<div class="flex items-center justify-between mb-2">
									<h3 class="text-sm font-medium text-text-primary">cURL</h3>
									<button
										class="flex items-center gap-1.5 rounded text-xs text-text-secondary hover:text-text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
										@click="copyToClipboard('curl')"
									>
										<Icon
											v-if="copiedSnippet === 'curl'"
											name="lucide:check"
											class="w-3.5 h-3.5 text-success"
										/>
										<Icon v-else name="lucide:copy" class="w-3.5 h-3.5" />
										{{
											copiedSnippet === 'curl'
												? t('dashboard.send.transactional.index.apiUsage.copied')
												: t('common.copy')
										}}
									</button>
								</div>
								<pre
									class="p-4 rounded-lg bg-bg-deep text-text-secondary text-sm font-mono overflow-x-auto whitespace-pre-wrap"
									>{{ getCodeSnippet('curl') }}</pre
								>
							</div>

							<!-- JavaScript -->
							<div>
								<div class="flex items-center justify-between mb-2">
									<h3 class="text-sm font-medium text-text-primary">JavaScript</h3>
									<button
										class="flex items-center gap-1.5 rounded text-xs text-text-secondary hover:text-text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
										@click="copyToClipboard('javascript')"
									>
										<Icon
											v-if="copiedSnippet === 'javascript'"
											name="lucide:check"
											class="w-3.5 h-3.5 text-success"
										/>
										<Icon v-else name="lucide:copy" class="w-3.5 h-3.5" />
										{{
											copiedSnippet === 'javascript'
												? t('dashboard.send.transactional.index.apiUsage.copied')
												: t('common.copy')
										}}
									</button>
								</div>
								<pre
									class="p-4 rounded-lg bg-bg-deep text-text-secondary text-sm font-mono overflow-x-auto whitespace-pre-wrap"
									>{{ getCodeSnippet('javascript') }}</pre
								>
							</div>

							<!-- Python -->
							<div>
								<div class="flex items-center justify-between mb-2">
									<h3 class="text-sm font-medium text-text-primary">Python</h3>
									<button
										class="flex items-center gap-1.5 rounded text-xs text-text-secondary hover:text-text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
										@click="copyToClipboard('python')"
									>
										<Icon
											v-if="copiedSnippet === 'python'"
											name="lucide:check"
											class="w-3.5 h-3.5 text-success"
										/>
										<Icon v-else name="lucide:copy" class="w-3.5 h-3.5" />
										{{
											copiedSnippet === 'python'
												? t('dashboard.send.transactional.index.apiUsage.copied')
												: t('common.copy')
										}}
									</button>
								</div>
								<pre
									class="p-4 rounded-lg bg-bg-deep text-text-secondary text-sm font-mono overflow-x-auto whitespace-pre-wrap"
									>{{ getCodeSnippet('python') }}</pre
								>
							</div>

							<div class="mt-4 p-4 rounded-lg bg-warning/10 border border-warning/20">
								<I18nT
									keypath="dashboard.send.transactional.index.apiUsage.note"
									tag="p"
									class="text-sm text-warning"
									scope="global"
								>
									<template #label>
										<strong>{{
											t('dashboard.send.transactional.index.apiUsage.noteLabel')
										}}</strong>
									</template>
									<template #placeholder>
										<code class="px-1 py-0.5 rounded bg-warning/20">YOUR_API_KEY</code>
									</template>
									<template #settings>
										<NuxtLink to="/dashboard/admin" class="underline hover:no-underline">{{
											t('common.settings')
										}}</NuxtLink>
									</template>
								</I18nT>
							</div>
						</div>

						<!-- Footer -->
						<div class="px-6 py-4 border-t border-border-subtle">
							<div class="flex justify-end">
								<UiButton variant="secondary" @click="closeCodeSnippetModal">
									{{ t('common.close') }}
								</UiButton>
							</div>
						</div>
					</div>
				</div>
			</Transition>
		</Teleport>

		<TransactionalRecentSendsModal
			v-model:open="isRecentSendsOpen"
			:email-id="recentSendsEmailId"
			:email-name="recentSendsEmailName"
		/>
	</div>
</template>
