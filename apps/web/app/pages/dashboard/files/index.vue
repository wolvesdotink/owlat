<script setup lang="ts">
useHead({ title: 'Files — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const {
	files,
	status,
	isLoading,
	searchQuery,
	sourceFilter,
	viewMode,
	loadMore,
} = useSemanticFiles();

// Uploading and deleting files is admin-only on the backend
// (semanticFiles mutations call requireAdminContext), so hide the
// affordances for non-admin members.
const { isAdmin } = usePermissions();

const showUploadModal = ref(false);

type SourceType = 'upload' | 'email_attachment' | 'agent_generated';
const sourceFilterOptions: { value: SourceType | null; label: string; icon?: string }[] = [
	{ value: null, label: 'All sources' },
	{ value: 'upload', label: 'Uploads', icon: 'lucide:upload' },
	{ value: 'email_attachment', label: 'Email attachments', icon: 'lucide:mail' },
	{ value: 'agent_generated', label: 'AI generated', icon: 'lucide:sparkles' },
];
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="flex items-center justify-between mb-6">
			<div>
				<h1 class="text-2xl font-semibold text-text-primary">Files</h1>
				<p class="text-text-secondary mt-1 text-sm">
					Manage documents, attachments, and AI-generated files.
				</p>
			</div>
			<button
				v-if="isAdmin"
				class="btn bg-brand text-white hover:bg-brand/90"
				@click="showUploadModal = true"
			>
				<Icon name="lucide:upload" class="w-4 h-4 mr-2" />
				Upload
			</button>
		</div>

		<!-- Filters bar -->
		<div class="flex items-center gap-3 mb-6">
			<!-- Search -->
			<div class="flex-1 max-w-sm">
				<div class="relative">
					<Icon name="lucide:search" class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary" />
					<input
						v-model="searchQuery"
						type="text"
						class="w-full rounded-lg border border-border-subtle bg-bg-base pl-9 pr-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent"
						placeholder="Search files..."
					/>
				</div>
			</div>

			<!-- Source filter -->
			<div class="flex items-center gap-1.5">
				<button
					v-for="opt in sourceFilterOptions"
					:key="String(opt.value)"
					type="button"
					class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-full border transition-colors"
					:class="sourceFilter === opt.value
						? 'bg-brand/10 border-brand text-brand'
						: 'bg-bg-surface border-border-subtle text-text-secondary hover:border-border-default hover:text-text-primary'"
					@click="sourceFilter = opt.value"
				>
					<Icon v-if="opt.icon" :name="opt.icon" class="w-3.5 h-3.5" />
					{{ opt.label }}
				</button>
			</div>

			<!-- View toggle -->
			<div class="flex items-center border border-border-subtle rounded-lg overflow-hidden ml-auto">
				<button
					class="p-2 transition-colors"
					:class="viewMode === 'grid'
						? 'bg-bg-surface text-text-primary'
						: 'text-text-tertiary hover:text-text-primary'"
					title="Grid view"
					@click="viewMode = 'grid'"
				>
					<Icon name="lucide:layout-grid" class="w-4 h-4" />
				</button>
				<button
					class="p-2 transition-colors"
					:class="viewMode === 'list'
						? 'bg-bg-surface text-text-primary'
						: 'text-text-tertiary hover:text-text-primary'"
					title="List view"
					@click="viewMode = 'list'"
				>
					<Icon name="lucide:list" class="w-4 h-4" />
				</button>
			</div>
		</div>

		<!-- Loading -->
		<div v-if="isLoading" class="flex items-center justify-center py-16">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner />
				<p class="text-text-secondary text-sm">Loading files...</p>
			</div>
		</div>

		<!-- Empty state -->
		<div
			v-else-if="!files || files.length === 0"
			class="flex flex-col items-center justify-center py-16 text-center"
		>
			<UiIconBox icon="lucide:folder-open" size="xl" variant="surface" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">
				{{ searchQuery ? 'No files match your search' : 'No files yet' }}
			</p>
			<p class="text-sm text-text-tertiary mt-1">
				{{ searchQuery ? 'Try adjusting your search terms.' : isAdmin ? 'Upload your first file to get started.' : 'Files will appear here once an admin uploads them.' }}
			</p>
			<button
				v-if="!searchQuery && isAdmin"
				class="btn bg-brand text-white hover:bg-brand/90 mt-4"
				@click="showUploadModal = true"
			>
				<Icon name="lucide:upload" class="w-4 h-4 mr-2" />
				Upload a file
			</button>
		</div>

		<!-- Grid view -->
		<div
			v-else-if="viewMode === 'grid'"
			class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4"
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
		<div v-else class="bg-bg-elevated border border-border-subtle rounded-lg overflow-hidden">
			<table class="w-full">
				<thead>
					<tr class="border-b border-border-subtle">
						<th class="text-left text-xs font-medium text-text-tertiary uppercase tracking-wider px-4 py-3">Name</th>
						<th class="text-left text-xs font-medium text-text-tertiary uppercase tracking-wider px-4 py-3">Type</th>
						<th class="text-left text-xs font-medium text-text-tertiary uppercase tracking-wider px-4 py-3">Size</th>
						<th class="text-left text-xs font-medium text-text-tertiary uppercase tracking-wider px-4 py-3">Source</th>
						<th class="text-left text-xs font-medium text-text-tertiary uppercase tracking-wider px-4 py-3">Date</th>
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
									:name="file.mimeType === 'application/pdf' ? 'lucide:file-text'
										: file.mimeType.startsWith('image/') ? 'lucide:image'
										: file.mimeType.startsWith('video/') ? 'lucide:film'
										: file.mimeType.startsWith('audio/') ? 'lucide:music'
										: 'lucide:file'"
									class="w-5 h-5 text-text-tertiary flex-shrink-0"
								/>
								<span class="text-sm font-medium text-text-primary truncate max-w-xs">
									{{ file.title || file.filename }}
								</span>
							</div>
						</td>
						<td class="px-4 py-3">
							<span class="text-sm text-text-secondary">{{ file.mimeType.split('/').pop() }}</span>
						</td>
						<td class="px-4 py-3">
							<span class="text-sm text-text-secondary">
								{{ file.fileSize < 1024 ? `${file.fileSize} B` : file.fileSize < 1024 * 1024 ? `${(file.fileSize / 1024).toFixed(1)} KB` : `${(file.fileSize / (1024 * 1024)).toFixed(1)} MB` }}
							</span>
						</td>
						<td class="px-4 py-3">
							<span
								class="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium rounded-full"
								:class="{
									'bg-bg-surface text-text-secondary': file.sourceType === 'upload',
									'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300': file.sourceType === 'email_attachment',
									'bg-brand-subtle text-brand': file.sourceType === 'agent_generated',
								}"
							>
								{{ file.sourceType === 'upload' ? 'Upload' : file.sourceType === 'email_attachment' ? 'Email' : 'AI' }}
							</span>
						</td>
						<td class="px-4 py-3">
							<span class="text-sm text-text-secondary">
								{{ new Date(file.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) }}
							</span>
						</td>
					</tr>
				</tbody>
			</table>
		</div>

		<!-- Load more -->
		<div
			v-if="files && files.length > 0 && status === 'CanLoadMore'"
			class="flex justify-center mt-8"
		>
			<UiButton variant="outline" size="sm" @click="loadMore()">
				Load more
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
