<script setup lang="ts">
/**
 * A brand font: the email-safe stacks first, then the web fonts, each web
 * font falling back to the safe font its stack names. A stored stack that is
 * not on the list (written before the brand kit, or through the API) stays
 * selectable so opening the page does not change it.
 */
import { BRAND_FONTS, brandFontByStack } from '@owlat/shared/brandKit';

defineProps<{ id: string; label: string; disabled?: boolean }>();

const stack = defineModel<string>({ required: true });
const { t } = useI18n();

const safeFonts = BRAND_FONTS.filter((font) => !font.webFontUrl);
const webFonts = BRAND_FONTS.filter((font) => font.webFontUrl);
const isUnlisted = computed(() => !brandFontByStack(stack.value));
const fontLabel = (id: string) => t(`dashboard.admin.instance.brandKit.typography.fonts.${id}`);
</script>

<template>
	<div>
		<label :for="id" class="label">{{ label }}</label>
		<select :id="id" v-model="stack" class="input" :disabled="disabled">
			<option v-if="isUnlisted" :value="stack">
				{{ t('dashboard.admin.instance.brandKit.typography.otherFont', { stack }) }}
			</option>
			<optgroup :label="t('dashboard.admin.instance.brandKit.typography.groupSafe')">
				<option v-for="font in safeFonts" :key="font.id" :value="font.stack">
					{{ fontLabel(font.id) }}
				</option>
			</optgroup>
			<optgroup :label="t('dashboard.admin.instance.brandKit.typography.groupWeb')">
				<option v-for="font in webFonts" :key="font.id" :value="font.stack">
					{{ fontLabel(font.id) }}
				</option>
			</optgroup>
		</select>
	</div>
</template>
