<script setup lang="ts">
const { t, locale } = useI18n();

useHead({ title: () => t('dashboard.files.index.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const { files, status, isLoading, error, refetch, searchQuery, sourceFilter, viewMode, loadMore } =
	useSemanticFiles();

// Uploading and deleting files is admin-only on the backend
// (semanticFiles mutations call requireAdminContext), so hide the
// affordances for non-admin members.
const { isAdmin } = usePermissions();

const showUploadModal = ref(false);

type SourceType = 'upload' | 'email_attachment' | 'agent_generated';
const sourceFilterOptions = computed<{ value: SourceType | null; label: string; icon?: string }[]>(
	() => [
		{ value: null, label: t('dashboard.files.index.sources.all') },
		{ value: 'upload', label: t('dashboard.files.index.sources.uploads'), icon: 'lucide:upload' },
		{
			value: 'email_attachment',
			label: t('dashboard.files.index.sources.emailAttachments'),
			icon: 'lucide:mail',
		},
		{
			value: 'agent_generated',
			label: t('dashboard.files.index.sources.aiGenerated'),
			icon: 'lucide:sparkles',
		},
	]
);

/** The short source badge in the list view. */
const sourceBadge = (sourceType: string) => {
	if (sourceType === 'upload') return t('dashboard.files.index.sourceBadge.upload');
	if (sourceType === 'email_attachment') return t('dashboard.files.index.sourceBadge.email');
	return t('dashboard.files.index.sourceBadge.ai');
};

const formatSize = (bytes: number) => {
	if (bytes < 1024) return t('dashboard.files.index.size.bytes', { size: bytes });
	if (bytes < 1024 * 1024)
		return t('dashboard.files.index.size.kilobytes', { size: (bytes / 1024).toFixed(1) });
	return t('dashboard.files.index.size.megabytes', { size: (bytes / (1024 * 1024)).toFixed(1) });
};

const formatCreatedAt = (createdAt: number) =>
	new Intl.DateTimeFormat(locale.value, {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
	}).format(new Date(createdAt));
</script>

<template>
	<div class="mx-auto w-full max-w-page p-6 lg:p-8">
		<UiPageHeader
			:title="t('dashboard.files.index.title')"
			:description="t('dashboard.files.index.subtitle')"
			class="mb-6"
		>
			<template v-if="isAdmin" #actions>
				<UiButton @click="showUploadModal = true">
					<Icon name="lucide:upload" class="w-4 h-4 mr-2" />
					{{ t('common.upload') }}
				</UiButton>
			</template>
		</UiPageHeader>

		<!-- Filters bar. Wraps below sm: the search takes its own row and the
		     source chips scroll sideways instead of pushing the view toggle (and
		     the page) off the right edge of a phone. -->
		<div class="flex flex-wrap items-center gap-3 mb-6">
			<!-- Search -->
			<div class="w-full sm:w-auto sm:flex-1 sm:max-w-sm">
				<div class="relative">
					<Icon
						name="lucide:search"
						class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary"
					/>
					<input
						v-model="searchQuery"
						type="text"
						class="input input-sm pl-9"
						:placeholder="t('dashboard.files.index.searchPlaceholder')"
						:aria-label="t('dashboard.files.index.searchPlaceholder')"
					/>
				</div>
			</div>

			<!-- Source filter -->
			<div class="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto sm:flex-none">
				<button
					v-for="opt in sourceFilterOptions"
					:key="String(opt.value)"
					type="button"
					class="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap px-3 py-1.5 text-xs font-medium rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
					:aria-pressed="sourceFilter === opt.value"
					:class="
						sourceFilter === opt.value
							? 'bg-brand/10 border-brand text-brand'
							: 'bg-bg-surface border-border-subtle text-text-secondary hover:border-border-default hover:text-text-primary'
					"
					@click="sourceFilter = opt.value"
				>
					<Icon v-if="opt.icon" :name="opt.icon" class="w-3.5 h-3.5" />
					{{ opt.label }}
				</button>
			</div>

			<!-- View toggle -->
			<div
				class="flex shrink-0 items-center border border-border-subtle rounded-lg overflow-hidden ml-auto"
			>
				<button
					type="button"
					class="p-2 transition-colors hover:bg-bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
					:class="
						viewMode === 'grid'
							? 'bg-bg-surface text-text-primary'
							: 'text-text-tertiary hover:text-text-primary'
					"
					:title="t('dashboard.files.index.gridView')"
					:aria-label="t('dashboard.files.index.gridView')"
					:aria-pressed="viewMode === 'grid'"
					@click="viewMode = 'grid'"
				>
					<Icon name="lucide:layout-grid" class="w-4 h-4" />
				</button>
				<button
					type="button"
					class="p-2 transition-colors hover:bg-bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
					:class="
						viewMode === 'list'
							? 'bg-bg-surface text-text-primary'
							: 'text-text-tertiary hover:text-text-primary'
					"
					:title="t('dashboard.files.index.listView')"
					:aria-label="t('dashboard.files.index.listView')"
					:aria-pressed="viewMode === 'list'"
					@click="viewMode = 'list'"
				>
					<Icon name="lucide:list" class="w-4 h-4" />
				</button>
			</div>
		</div>

		<UiQueryBoundary
			:loading="isLoading"
			:error="error"
			@retry="refetch"
			:error-title="t('dashboard.files.index.errorTitle')"
			:loading-label="t('dashboard.files.index.loadingLabel')"
		>
			<!-- Empty state -->
			<div
				v-if="!files || files.length === 0"
				class="flex flex-col items-center justify-center py-16 text-center"
			>
				<UiIconBox
					icon="lucide:folder-open"
					size="xl"
					variant="surface"
					rounded="full"
					class="mb-4"
				/>
				<p class="text-text-secondary font-medium">
					{{
						searchQuery
							? t('dashboard.files.index.empty.noMatches')
							: t('dashboard.files.index.empty.noFiles')
					}}
				</p>
				<p class="text-sm text-text-tertiary mt-1">
					{{
						searchQuery
							? t('dashboard.files.index.empty.adjustSearch')
							: isAdmin
								? t('dashboard.files.index.empty.uploadFirst')
								: t('dashboard.files.index.empty.waitForAdmin')
					}}
				</p>
				<UiButton v-if="!searchQuery && isAdmin" class="mt-4" @click="showUploadModal = true">
					<Icon name="lucide:upload" class="w-4 h-4 mr-2" />
					{{ t('dashboard.files.index.uploadFile') }}
				</UiButton>
			</div>

			<!-- Grid view -->
			<div
				v-else-if="viewMode === 'grid'"
				class="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-4"
			>
				<FilesFileCard
					v-for="file in files"
					:key="file._id"
					:id="file._id"
					:filename="file.filename"
					:title="file.title"
					:mime-type="file.mimeType"
					:file-size="file.fileSize"
					:tags="file.tags"
					:auto-tags="file.autoTags"
					:source-type="file.sourceType"
					:created-at="file.createdAt"
				/>
			</div>

			<!-- List view -->
			<div v-else class="bg-bg-elevated shadow-surface-1 rounded-(--radius-card) overflow-x-auto">
				<table class="w-full">
					<thead>
						<tr class="border-b border-border-subtle">
							<th
								class="text-left text-xs font-medium text-text-tertiary uppercase tracking-wider px-4 py-3"
							>
								{{ t('common.name') }}
							</th>
							<th
								class="hidden md:table-cell text-left text-xs font-medium text-text-tertiary uppercase tracking-wider px-4 py-3"
							>
								{{ t('dashboard.files.index.columns.type') }}
							</th>
							<th
								class="text-left text-xs font-medium text-text-tertiary uppercase tracking-wider px-4 py-3"
							>
								{{ t('dashboard.files.index.columns.size') }}
							</th>
							<th
								class="hidden sm:table-cell text-left text-xs font-medium text-text-tertiary uppercase tracking-wider px-4 py-3"
							>
								{{ t('dashboard.files.index.columns.source') }}
							</th>
							<th
								class="text-left text-xs font-medium text-text-tertiary uppercase tracking-wider px-4 py-3"
							>
								{{ t('dashboard.files.index.columns.date') }}
							</th>
						</tr>
					</thead>
					<tbody>
						<tr
							v-for="file in files"
							:key="file._id"
							class="border-b border-border-subtle last:border-0 hover:bg-bg-surface cursor-pointer transition-colors"
							@click="$router.push(`/dashboard/files/${file._id}`)"
						>
							<td class="px-4 py-3">
								<div class="flex items-center gap-3">
									<Icon
										:name="
											file.mimeType === 'application/pdf'
												? 'lucide:file-text'
												: file.mimeType.startsWith('image/')
													? 'lucide:image'
													: file.mimeType.startsWith('video/')
														? 'lucide:film'
														: file.mimeType.startsWith('audio/')
															? 'lucide:music'
															: 'lucide:file'
										"
										class="w-5 h-5 text-text-tertiary flex-shrink-0"
									/>
									<!-- The row is clickable for the pointer; the link is the
									     keyboard (and middle-click) way in. -->
									<NuxtLink
										:to="`/dashboard/files/${file._id}`"
										class="text-sm font-medium text-text-primary truncate max-w-xs rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
										@click.stop
									>
										{{ file.title || file.filename }}
									</NuxtLink>
								</div>
							</td>
							<!-- The raw subtype can be 50 characters of OOXML
							     (vnd.openxmlformats-officedocument…); cap it so it does
							     not squeeze size and date onto two lines. -->
							<td class="hidden md:table-cell px-4 py-3">
								<span
									class="block max-w-[12rem] truncate text-sm text-text-secondary"
									:title="file.mimeType"
									>{{ file.mimeType.split('/').pop() }}</span
								>
							</td>
							<td class="px-4 py-3">
								<span class="whitespace-nowrap text-sm text-text-secondary">{{
									formatSize(file.fileSize)
								}}</span>
							</td>
							<td class="hidden sm:table-cell px-4 py-3">
								<span
									class="inline-flex items-center gap-1 px-2 py-0.5 text-2xs font-medium rounded-full"
									:class="{
										'bg-bg-surface text-text-secondary': file.sourceType === 'upload',
										'bg-info-subtle text-info': file.sourceType === 'email_attachment',
										'bg-brand-subtle text-brand': file.sourceType === 'agent_generated',
									}"
								>
									{{ sourceBadge(file.sourceType) }}
								</span>
							</td>
							<td class="px-4 py-3">
								<span class="whitespace-nowrap text-sm text-text-secondary">
									{{ formatCreatedAt(file.createdAt) }}
								</span>
							</td>
						</tr>
					</tbody>
				</table>
			</div>
		</UiQueryBoundary>

		<!-- Load more -->
		<div
			v-if="files && files.length > 0 && status === 'CanLoadMore'"
			class="flex justify-center mt-8"
		>
			<UiButton variant="outline" size="sm" @click="loadMore()">
				{{ t('dashboard.files.index.loadMore') }}
			</UiButton>
		</div>

		<!-- Upload modal -->
		<FilesFileUploadModal
			:open="showUploadModal"
			@update:open="showUploadModal = $event"
			@uploaded="showUploadModal = false"
		/>
	</div>
</template>
