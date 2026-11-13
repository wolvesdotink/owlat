<script setup lang="ts">
/** The file detail page's "Details" card: type, size, creation date and where the file came from. */
import { MailIcon, SparklesIcon, UploadIcon } from '@coolicons/vue';

const props = defineProps<{
	mimeType: string;
	fileSize: number;
	createdAt: number;
	sourceType: string;
}>();

const { t } = useI18n();

// The raw MIME type ("application/vnd.openxmlformats-…") means nothing to most
// people; show the kind of file and keep the exact type in the tooltip.
const fileKind = computed(() => {
	const mime = props.mimeType.toLowerCase();
	const kind = (key: string) => t(`dashboard.files.detail.fileKinds.${key}`);
	if (mime === 'application/pdf') return kind('pdf');
	if (mime.startsWith('image/')) return kind('image');
	if (mime.startsWith('video/')) return kind('video');
	if (mime.startsWith('audio/')) return kind('audio');
	if (mime.includes('csv') || mime.includes('spreadsheet') || mime.includes('excel'))
		return kind('spreadsheet');
	if (mime.includes('presentation') || mime.includes('powerpoint')) return kind('presentation');
	if (mime.includes('word') || mime.includes('opendocument.text') || mime.includes('rtf'))
		return kind('document');
	if (mime.includes('zip') || mime.includes('compressed') || mime.includes('tar'))
		return kind('archive');
	if (mime.startsWith('text/')) return kind('text');
	return props.mimeType;
});

const sourceLabel = computed(() => {
	switch (props.sourceType) {
		case 'upload':
			return t('dashboard.files.detail.source.upload');
		case 'email_attachment':
			return t('dashboard.files.detail.source.emailAttachment');
		case 'agent_generated':
			return t('dashboard.files.detail.source.aiGenerated');
		default:
			return props.sourceType;
	}
});
</script>

<template>
	<div class="bg-surface-2 shadow-surface-1 rounded-(--radius-card) p-5 space-y-4">
		<h3 class="text-sm font-semibold text-text-primary">
			{{ t('dashboard.files.detail.details') }}
		</h3>

		<div class="space-y-3">
			<div>
				<p class="text-xs text-text-tertiary mb-0.5">
					{{ t('dashboard.files.detail.fileType') }}
				</p>
				<p class="text-sm text-text-secondary truncate" :title="mimeType">{{ fileKind }}</p>
			</div>
			<div>
				<p class="text-xs text-text-tertiary mb-0.5">
					{{ t('dashboard.files.detail.fileSize') }}
				</p>
				<p class="text-sm text-text-secondary">
					{{ formatCompactFileSize(fileSize) }}
				</p>
			</div>
			<div>
				<p class="text-xs text-text-tertiary mb-0.5">
					{{ t('dashboard.files.detail.created') }}
				</p>
				<p class="text-sm text-text-secondary">{{ formatDateTime(createdAt) }}</p>
			</div>
			<div>
				<p class="text-xs text-text-tertiary mb-0.5">
					{{ t('dashboard.files.detail.sourceLabel') }}
				</p>
				<span
					class="inline-flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded-full"
					:class="{
						'bg-bg-surface text-text-secondary': sourceType === 'upload',
						'bg-info-subtle text-info': sourceType === 'email_attachment',
						'bg-brand-subtle text-brand': sourceType === 'agent_generated',
					}"
				>
					<component
						:is="
							sourceType === 'upload'
								? UploadIcon
								: sourceType === 'email_attachment'
									? MailIcon
									: SparklesIcon
						"
						class="w-3.5 h-3.5"
						aria-hidden="true"
					/>
					{{ sourceLabel }}
				</span>
			</div>
		</div>
	</div>
</template>
