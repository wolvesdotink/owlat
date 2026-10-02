<script setup lang="ts">
/**
 * The brand kit's extra swatches: up to `MAX_BRAND_SWATCHES` colours the
 * editor's pickers offer after the five named ones.
 */
import { MAX_BRAND_SWATCHES, isBrandHexColor } from '@owlat/shared/brandKit';

defineProps<{ disabled?: boolean }>();

const swatches = defineModel<string[]>({ required: true });
const { t } = useI18n();

const canAdd = computed(() => swatches.value.length < MAX_BRAND_SWATCHES);

function add() {
	if (canAdd.value) swatches.value = [...swatches.value, '#888888'];
}

function update(index: number, value: string) {
	swatches.value = swatches.value.map((c, i) => (i === index ? value.trim().toLowerCase() : c));
}

function remove(index: number) {
	swatches.value = swatches.value.filter((_, i) => i !== index);
}
</script>

<template>
	<div>
		<p class="label">{{ t('dashboard.admin.instance.brandKit.colors.swatches') }}</p>
		<ul class="flex flex-wrap gap-2" data-testid="brand-kit-swatches">
			<li
				v-for="(color, index) in swatches"
				:key="index"
				class="flex items-center gap-1.5 rounded-lg border border-border-subtle bg-bg-surface p-1 pr-1.5"
			>
				<input
					:value="isBrandHexColor(color) ? color : '#000000'"
					type="color"
					class="w-7 h-7 rounded-md cursor-pointer bg-transparent"
					:aria-label="t('dashboard.admin.instance.brandKit.colors.pickColor', { label: color })"
					:disabled="disabled"
					@input="update(index, ($event.target as HTMLInputElement).value)"
				/>
				<input
					:value="color"
					type="text"
					spellcheck="false"
					:class="[
						'w-20 bg-transparent text-xs font-mono text-text-primary outline-none',
						!isBrandHexColor(color) && 'text-error',
					]"
					:aria-label="t('dashboard.admin.instance.brandKit.colors.swatchValue', { n: index + 1 })"
					:disabled="disabled"
					@change="update(index, ($event.target as HTMLInputElement).value)"
				/>
				<button
					type="button"
					class="flex items-center justify-center w-6 h-6 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-surface-hover"
					:aria-label="t('dashboard.admin.instance.brandKit.colors.removeSwatch', { color })"
					:disabled="disabled"
					@click="remove(index)"
				>
					<Icon name="lucide:x" class="w-3.5 h-3.5" />
				</button>
			</li>
			<li>
				<UiButton
					variant="ghost"
					size="sm"
					type="button"
					:disabled="disabled || !canAdd"
					class="h-[38px]"
					@click="add"
				>
					<template #iconLeft><Icon name="lucide:plus" class="w-4 h-4" /></template>
					{{ t('dashboard.admin.instance.brandKit.colors.addSwatch') }}
				</UiButton>
			</li>
		</ul>
		<p class="mt-1 text-xs text-text-tertiary">
			{{ t('dashboard.admin.instance.brandKit.colors.swatchesHelp', { max: MAX_BRAND_SWATCHES }) }}
		</p>
	</div>
</template>
