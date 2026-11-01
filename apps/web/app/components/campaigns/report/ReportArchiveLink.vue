<script setup lang="ts">
// The campaign report's public archive link, with Copy link.
const props = defineProps<{ archiveUrl: string }>();

const { t } = useI18n();

const { copy: copyToClipboard, copiedKey: archiveCopiedKey } = useCopyToClipboard();
const ARCHIVE_LINK_COPY_KEY = 'archive-link';
const archiveCopied = computed(() => archiveCopiedKey.value === ARCHIVE_LINK_COPY_KEY);
const copyArchiveLink = async () => {
	if (!props.archiveUrl) return;
	await copyToClipboard(props.archiveUrl, ARCHIVE_LINK_COPY_KEY);
};
</script>

<template>
	<div class="card p-4 mb-8">
		<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
			<div class="flex items-center gap-3 min-w-0">
				<UiIconBox icon="lucide:globe" size="sm" rounded="lg" />
				<div class="min-w-0">
					<p class="text-sm font-medium text-text-primary">
						{{ t('dashboard.campaigns.detail.report.archive.title') }}
					</p>
					<p class="text-xs text-text-tertiary truncate sm:max-w-md">{{ archiveUrl }}</p>
				</div>
			</div>
			<UiButton
				variant="secondary"
				class="text-sm gap-1.5 self-start sm:self-auto shrink-0"
				@click="copyArchiveLink"
			>
				<Icon :name="archiveCopied ? 'lucide:check' : 'lucide:copy'" class="w-3.5 h-3.5" />
				{{
					archiveCopied
						? t('common.copied')
						: t('dashboard.campaigns.detail.report.archive.copyLink')
				}}
			</UiButton>
		</div>
	</div>
</template>
