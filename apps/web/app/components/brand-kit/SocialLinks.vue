<script setup lang="ts">
/** The footer's social links: a platform and a profile URL each. */
import { SOCIAL_PLATFORMS, type SocialPlatform } from '@owlat/shared';
import {
	MAX_BRAND_SOCIAL_LINKS,
	isBrandLinkUrl,
	type BrandSocialLink,
} from '@owlat/shared/brandKit';

defineProps<{ disabled?: boolean }>();

const links = defineModel<BrandSocialLink[]>({ required: true });
const { t } = useI18n();

const platforms = (Object.entries(SOCIAL_PLATFORMS) as [SocialPlatform, { label: string }][]).map(
	([value, meta]) => ({ value, label: meta.label })
);
const canAdd = computed(() => links.value.length < MAX_BRAND_SOCIAL_LINKS);

function add() {
	if (!canAdd.value) return;
	const used = new Set(links.value.map((l) => l.platform));
	const platform = platforms.find((p) => !used.has(p.value))?.value ?? 'twitter';
	links.value = [...links.value, { platform, url: '' }];
}

function update(index: number, patch: Partial<BrandSocialLink>) {
	links.value = links.value.map((link, i) => (i === index ? { ...link, ...patch } : link));
}

function remove(index: number) {
	links.value = links.value.filter((_, i) => i !== index);
}

const platformLabel = (platform: SocialPlatform) => SOCIAL_PLATFORMS[platform].label;
</script>

<template>
	<div>
		<p class="label">{{ t('dashboard.admin.instance.brandKit.footer.socialLinks') }}</p>
		<ul v-if="links.length > 0" class="space-y-2 mb-2">
			<li v-for="(link, index) in links" :key="index" class="flex items-start gap-2">
				<select
					:value="link.platform"
					class="input w-36 shrink-0"
					:aria-label="t('dashboard.admin.instance.brandKit.footer.platform')"
					:disabled="disabled"
					@change="
						update(index, {
							platform: ($event.target as HTMLSelectElement).value as SocialPlatform,
						})
					"
				>
					<option v-for="p in platforms" :key="p.value" :value="p.value">{{ p.label }}</option>
				</select>
				<div class="flex-1 min-w-0">
					<input
						:value="link.url"
						type="url"
						inputmode="url"
						class="input"
						:class="link.url && !isBrandLinkUrl(link.url) && 'input-error'"
						:placeholder="t('dashboard.admin.instance.brandKit.footer.urlPlaceholder')"
						:aria-label="
							t('dashboard.admin.instance.brandKit.footer.url', {
								platform: platformLabel(link.platform),
							})
						"
						:disabled="disabled"
						@input="update(index, { url: ($event.target as HTMLInputElement).value })"
					/>
					<p v-if="link.url && !isBrandLinkUrl(link.url)" class="mt-1 text-xs text-error">
						{{ t('dashboard.admin.instance.brandKit.errors.invalidSocialUrl') }}
					</p>
				</div>
				<UiButton
					variant="ghost"
					size="sm"
					type="button"
					class="h-[38px]"
					:aria-label="
						t('dashboard.admin.instance.brandKit.footer.removeSocialLink', {
							platform: platformLabel(link.platform),
						})
					"
					:disabled="disabled"
					@click="remove(index)"
				>
					<Icon name="lucide:trash-2" class="w-4 h-4" />
				</UiButton>
			</li>
		</ul>
		<UiButton variant="ghost" size="sm" type="button" :disabled="disabled || !canAdd" @click="add">
			<template #iconLeft><Icon name="lucide:plus" class="w-4 h-4" /></template>
			{{ t('dashboard.admin.instance.brandKit.footer.addSocialLink') }}
		</UiButton>
	</div>
</template>
