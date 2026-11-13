<script setup lang="ts">
/**
 * The files a saved reply carries, in its editor: the list, "Add files" and
 * removing one. A new file is uploaded at once and becomes the reply's when
 * the form is saved; one never saved expires with its upload. The composer's
 * limits apply, since inserting the reply puts every file on a draft.
 */
import { api } from '@owlat/api';
import { ATTACHMENT_COMPOSE_LIMITS, MAX_ATTACHMENT_BYTES } from '@owlat/shared/attachments';
import type { SavedReplyFile } from '~/composables/useSavedReplies';
import { uploadFileToStorage } from '~/utils/storageUpload';
import { CloseIcon, PaperclipIcon } from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

const files = defineModel<SavedReplyFile[]>({ required: true });
/** True while a file is still on its way up: the form waits for it. */
const uploading = defineModel<boolean>('uploading', { default: false });

const { t, locale } = useI18n();
const { showToast } = useToast();
const generateUploadUrl = useBackendOperation(api.storage.files.generateUploadUrl, {
	label: () => t('shared.postbox.usePostboxComposeAttachments.prepareUploadOperation'),
});
const input = ref<HTMLInputElement | null>(null);

const toMb = (bytes: number) => new Intl.NumberFormat(locale.value).format(bytes / 1024 / 1024);

/** The files that fit, with a toast for the first limit one breaks. */
function accept(picked: File[]): File[] {
	let count = files.value.length;
	let bytes = files.value.reduce((sum, file) => sum + file.size, 0);
	const kept: File[] = [];
	for (const file of picked) {
		const key = 'shared.postbox.usePostboxComposeAttachments';
		if (file.size > MAX_ATTACHMENT_BYTES) {
			showToast(
				t(`${key}.tooLarge`, { filename: file.name, max: toMb(MAX_ATTACHMENT_BYTES) }),
				'error'
			);
			continue;
		}
		if (count >= ATTACHMENT_COMPOSE_LIMITS.maxCount) {
			showToast(t(`${key}.tooManyFiles`, { count: ATTACHMENT_COMPOSE_LIMITS.maxCount }), 'error');
			break;
		}
		if (bytes + file.size > ATTACHMENT_COMPOSE_LIMITS.maxTotalBytes) {
			showToast(
				t(`${key}.totalTooLarge`, { max: toMb(ATTACHMENT_COMPOSE_LIMITS.maxTotalBytes) }),
				'error'
			);
			break;
		}
		kept.push(file);
		count += 1;
		bytes += file.size;
	}
	return kept;
}

async function add(event: Event) {
	const target = event.target as HTMLInputElement;
	// Read before the input is cleared: a live FileList empties with it.
	const picked = accept([...(target.files ?? [])]);
	target.value = '';
	if (picked.length === 0) return;
	uploading.value = true;
	try {
		for (const file of picked) {
			const contentType = file.type || 'application/octet-stream';
			const uploaded = await uploadFileToStorage(
				file,
				() => generateUploadUrl.run({}),
				contentType
			).catch(() => ({ ok: false as const }));
			if (!uploaded.ok) {
				showToast(
					t('shared.postbox.usePostboxComposeAttachments.uploadFailed', { filename: file.name }),
					'error'
				);
				continue;
			}
			files.value = [
				...files.value,
				{ storageId: uploaded.storageId, filename: file.name, contentType, size: file.size },
			];
		}
	} finally {
		uploading.value = false;
	}
}

function remove(file: SavedReplyFile) {
	files.value = files.value.filter((held) => held.storageId !== file.storageId);
}
</script>

<template>
	<div data-testid="saved-reply-files">
		<span class="mb-1 block text-sm text-text-secondary">
			{{ t('shared.savedReplies.fields.files') }}
		</span>
		<p class="mb-2 text-xs text-text-tertiary">{{ t('shared.savedReplies.fields.filesHint') }}</p>
		<div class="flex flex-wrap items-center gap-2">
			<span
				v-for="file in files"
				:key="file.storageId"
				class="inline-flex items-center gap-1.5 rounded bg-bg-surface py-1 pl-1.5 pr-1 text-xs"
			>
				<PaperclipIcon class="h-3 w-3 text-text-tertiary" aria-hidden="true" />
				<span class="max-w-[180px] truncate" :title="file.filename">{{ file.filename }}</span>
				<span class="text-text-tertiary">{{ formatCompactFileSize(file.size) }}</span>
				<button
					type="button"
					class="rounded p-0.5 text-text-tertiary hover:bg-bg-elevated hover:text-text-primary pointer-coarse:p-2"
					:aria-label="t('shared.savedReplies.fields.removeFile', { filename: file.filename })"
					@click="remove(file)"
				>
					<CloseIcon class="h-3 w-3" />
				</button>
			</span>
			<UiButton
				variant="ghost"
				size="sm"
				type="button"
				:disabled="uploading || files.length >= ATTACHMENT_COMPOSE_LIMITS.maxCount"
				data-testid="saved-reply-add-files"
				@click="input?.click()"
			>
				<component
					:is="uploading ? SpinnerIcon : PaperclipIcon"
					class="mr-1.5 h-4 w-4"
					:class="uploading ? 'animate-spin motion-reduce:animate-none' : ''"
				/>
				{{ t('shared.savedReplies.fields.addFiles') }}
			</UiButton>
			<input ref="input" type="file" multiple class="hidden" @change="add" />
		</div>
	</div>
</template>
