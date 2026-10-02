<script setup lang="ts">
/**
 * One logo slot of the brand kit, filled from the media library. The file
 * stays in the library; the kit only points at it.
 */
import type { BrandLogoAsset } from '@owlat/shared/brandKitBlocks';

const props = defineProps<{
	label: string;
	help: string;
	/** Draw the thumbnail on a dark plate (the dark-mode slot). */
	isDark?: boolean;
	disabled?: boolean;
}>();

const logo = defineModel<BrandLogoAsset | null>({ required: true });
const { t } = useI18n();
const isPickerOpen = ref(false);

function handleSelect(asset: {
	url: string;
	storageId: string;
	mediaAssetId: string;
	width?: number;
}) {
	logo.value = {
		url: asset.url,
		storageId: asset.storageId,
		mediaAssetId: asset.mediaAssetId,
		...(asset.width ? { width: asset.width } : {}),
	};
}
</script>

<template>
	<div class="flex items-center gap-4">
		<div
			class="w-28 h-16 shrink-0 rounded-lg border border-border-subtle flex items-center justify-center overflow-hidden p-2"
			:class="props.isDark ? 'bg-[#18181b]' : 'bg-white'"
		>
			<img v-if="logo" :src="logo.url" :alt="label" class="max-w-full max-h-full object-contain" />
			<Icon v-else name="lucide:image" class="w-5 h-5 text-text-tertiary" />
		</div>
		<div class="min-w-0 flex-1">
			<p class="text-sm font-medium text-text-primary">{{ label }}</p>
			<p class="text-xs text-text-tertiary">{{ help }}</p>
			<div class="mt-2 flex flex-wrap gap-2">
				<UiButton
					variant="secondary"
					size="sm"
					type="button"
					:disabled="disabled"
					@click="isPickerOpen = true"
				>
					{{
						logo
							? t('dashboard.admin.instance.brandKit.logo.replace')
							: t('dashboard.admin.instance.brandKit.logo.choose')
					}}
				</UiButton>
				<UiButton
					v-if="logo"
					variant="ghost"
					size="sm"
					type="button"
					:disabled="disabled"
					@click="logo = null"
				>
					{{ t('dashboard.admin.instance.brandKit.logo.remove') }}
				</UiButton>
			</div>
		</div>
		<MediaPickerModal
			:open="isPickerOpen"
			:title="t('dashboard.admin.instance.brandKit.logo.pickerTitle')"
			accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
			@update:open="isPickerOpen = $event"
			@select="handleSelect"
		/>
	</div>
</template>
