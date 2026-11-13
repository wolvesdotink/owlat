<script lang="ts">
import { FileIcon, FileTextIcon, FilmIcon, MusicNoteIcon } from '@coolicons/vue';

/** The placeholder icon for an asset that has no image preview. */
export const getFileIcon = (mimeType: string) => {
	if (mimeType === 'application/pdf') return FileTextIcon;
	if (mimeType.startsWith('video/')) return FilmIcon;
	if (mimeType.startsWith('audio/')) return MusicNoteIcon;
	return FileIcon;
};
</script>

<script setup lang="ts">
// The media library's detail dialog: preview, size and usage, alt text and
// tags (editable by admins), copy URL and delete. The page owns the library
// and which asset is open; the dialog owns the edits.
import { api } from '@owlat/api';
import type { useMediaLibrary } from '~/composables/useMediaLibrary';
import { CopyIcon, TrashIcon } from '@coolicons/vue';

type MediaLibrary = ReturnType<typeof useMediaLibrary>;
type MediaAsset = MediaLibrary['assets']['value'][number];

const props = defineProps<{
	isAdmin: boolean;
	updateAsset: MediaLibrary['updateAsset'];
	deleteAssets: MediaLibrary['deleteAssets'];
}>();

/** The open asset; `null` closes the dialog. */
const detailAsset = defineModel<MediaAsset | null>('asset', { required: true });

const { t } = useI18n();

const editAlt = ref('');
const editTags = ref('');

// Opening an asset starts its edits from what is stored.
watch(
	detailAsset,
	(asset) => {
		if (!asset) return;
		editAlt.value = asset.alt || '';
		editTags.value = (asset.tags || []).join(', ');
	},
	{ immediate: true }
);

// How many templates / transactional emails reference the open asset. Reactive
// one-shot query, skipped until a detail asset is selected.
const { data: usage } = useConvexQuery(api.workspaces.mediaAssets.countUsage, () =>
	detailAsset.value ? { assetId: detailAsset.value._id } : 'skip'
);
const usageCount = computed(() => usage.value?.count ?? null);

const isSavingDetail = ref(false);
const saveDetail = async () => {
	if (!detailAsset.value || isSavingDetail.value) return;
	const tagArray = editTags.value
		.split(',')
		.map((t) => t.trim())
		.filter(Boolean);
	isSavingDetail.value = true;
	try {
		const saved = await props.updateAsset(detailAsset.value._id, {
			alt: editAlt.value,
			tags: tagArray,
		});
		// A refused save keeps the dialog open with the alt text and tags typed.
		if (!saved) return;
		detailAsset.value = null;
	} finally {
		isSavingDetail.value = false;
	}
};

// Deleting one asset asks first like bulk delete does, and says how many
// emails would lose the image.
const askConfirm = useConfirm();
const deleteDetailAsset = async () => {
	const asset = detailAsset.value;
	if (!asset) return;
	const count = usageCount.value ?? 0;
	const confirmed = await askConfirm({
		title: t('dashboard.send.media.deleteOneTitle', { name: asset.filename }),
		body:
			count > 0
				? t('dashboard.send.media.deleteOneInUse', { count }, count)
				: t('dashboard.send.media.deleteOneBody'),
		confirmText: t('common.delete'),
		variant: 'danger',
	});
	if (!confirmed) return;
	await props.deleteAssets([asset._id]);
	if (detailAsset.value?._id === asset._id) detailAsset.value = null;
};

const { copy: copyToClipboard } = useCopyToClipboard({ notify: false });
const { showToast } = useToast();
const copyUrl = async (url: string) => {
	if (await copyToClipboard(url)) {
		showToast(t('dashboard.send.media.urlCopied'));
	} else {
		showToast(t('dashboard.send.media.urlCopyFailed'), 'error');
	}
};
</script>

<template>
	<UiModal
		:open="!!detailAsset"
		:title="t('dashboard.send.media.detailTitle')"
		size="lg"
		@update:open="
			(v: boolean) => {
				if (!v) detailAsset = null;
			}
		"
	>
		<template v-if="detailAsset">
			<div class="flex flex-col md:flex-row gap-6">
				<!-- Preview -->
				<div class="md:w-1/2 flex-shrink-0">
					<div
						class="aspect-square bg-checker rounded-lg overflow-hidden flex items-center justify-center"
					>
						<img
							v-if="detailAsset.mimeType?.startsWith('image/')"
							:src="detailAsset.url"
							:alt="detailAsset.alt || detailAsset.filename"
							class="max-w-full max-h-full object-contain"
						/>
						<div v-else class="flex flex-col items-center justify-center gap-3">
							<component
								:is="getFileIcon(detailAsset.mimeType || '')"
								class="w-16 h-16 text-text-tertiary"
								:stroke-width="1.5"
							/>
							<span class="text-sm text-text-secondary">{{ detailAsset.filename }}</span>
						</div>
					</div>
				</div>
				<!-- Fields -->
				<div class="flex-1 space-y-4">
					<div>
						<p class="text-sm font-medium text-text-primary">{{ detailAsset.filename }}</p>
						<p class="text-xs text-text-tertiary mt-1">
							{{ formatCompactFileSize(detailAsset.fileSize) }}
							<template v-if="detailAsset.width && detailAsset.height">
								&middot; {{ detailAsset.width }}&times;{{ detailAsset.height }}
							</template>
						</p>
						<p v-if="usageCount !== null" class="text-xs text-text-secondary mt-1">
							{{
								usageCount === 0
									? t('dashboard.send.media.usageNone')
									: t('dashboard.send.media.usageCount', { count: usageCount }, usageCount)
							}}
						</p>
					</div>

					<template v-if="isAdmin">
						<UiInput
							v-model="editAlt"
							:label="t('dashboard.send.media.altText')"
							:placeholder="t('dashboard.send.media.altPlaceholder')"
						/>
						<UiInput
							v-model="editTags"
							:label="t('dashboard.send.media.tags')"
							:placeholder="t('dashboard.send.media.tagsPlaceholder')"
						/>
					</template>
					<template v-else>
						<div v-if="detailAsset.alt">
							<p class="text-xs font-medium text-text-secondary mb-1">
								{{ t('dashboard.send.media.altText') }}
							</p>
							<p class="text-sm text-text-primary">{{ detailAsset.alt }}</p>
						</div>
						<div v-if="detailAsset.tags && detailAsset.tags.length">
							<p class="text-xs font-medium text-text-secondary mb-1">
								{{ t('dashboard.send.media.tags') }}
							</p>
							<p class="text-sm text-text-primary">{{ detailAsset.tags.join(', ') }}</p>
						</div>
					</template>

					<div class="flex flex-wrap items-center gap-2 pt-2">
						<UiButton variant="outline" size="sm" @click="copyUrl(detailAsset.url)">
							<template #iconLeft>
								<CopyIcon class="w-3.5 h-3.5" />
							</template>
							{{ t('dashboard.send.media.copyUrl') }}
						</UiButton>
						<UiButton v-if="isAdmin" variant="danger-outline" size="sm" @click="deleteDetailAsset">
							<template #iconLeft>
								<TrashIcon class="w-3.5 h-3.5" />
							</template>
							{{ t('common.delete') }}
						</UiButton>
					</div>
				</div>
			</div>
		</template>

		<template #footer>
			<UiButton variant="secondary" @click="detailAsset = null">{{
				isAdmin ? t('common.cancel') : t('common.close')
			}}</UiButton>
			<UiButton v-if="isAdmin" variant="primary" :loading="isSavingDetail" @click="saveDetail">
				{{ t('common.save') }}
			</UiButton>
		</template>
	</UiModal>
</template>
