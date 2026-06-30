<script setup lang="ts">
defineProps<{
	versions: Array<{
		_id: string;
		filename: string;
		fileSize: number;
		createdAt: number;
		version?: number;
		changeSummary?: string;
		url?: string | null;
	}>;
	currentVersionId?: string;
}>();

</script>

<template>
	<div v-if="versions.length === 0" class="text-sm text-text-tertiary py-4">
		No previous versions.
	</div>
	<div v-else class="relative">
		<!-- Timeline line -->
		<div class="absolute left-4 top-3 bottom-3 w-px bg-border-subtle" />

		<div class="space-y-0">
			<div
				v-for="(version, index) in versions"
				:key="version._id"
				class="relative flex items-start gap-4 py-3"
			>
				<!-- Timeline dot -->
				<div
					class="relative z-10 flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center"
					:class="version._id === currentVersionId
						? 'bg-brand text-white'
						: 'bg-bg-surface border border-border-subtle text-text-tertiary'"
				>
					<span class="text-xs font-semibold">{{ version.version ?? versions.length - index }}</span>
				</div>

				<!-- Version info -->
				<div class="flex-1 min-w-0 pt-0.5">
					<div class="flex items-center gap-2">
						<p class="text-sm font-medium text-text-primary truncate">
							{{ version.filename }}
						</p>
						<span
							v-if="version._id === currentVersionId"
							class="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-brand-subtle text-brand"
						>
							Current
						</span>
					</div>
					<div class="flex items-center gap-2 mt-0.5">
						<span class="text-xs text-text-tertiary">{{ formatCompactFileSize(version.fileSize) }}</span>
						<span class="text-xs text-text-tertiary">&middot;</span>
						<span class="text-xs text-text-tertiary">{{ formatDateTime(version.createdAt) }}</span>
					</div>
					<p v-if="version.changeSummary" class="text-xs text-text-tertiary mt-1 italic">
						{{ version.changeSummary }}
					</p>
				</div>

				<!-- Download link -->
				<a
					v-if="version.url"
					:href="version.url"
					target="_blank"
					rel="noopener noreferrer"
					class="flex-shrink-0 p-1.5 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-surface transition-colors"
					title="Download this version"
					@click.stop
				>
					<Icon name="lucide:download" class="w-4 h-4" />
				</a>
			</div>
		</div>
	</div>
</template>
