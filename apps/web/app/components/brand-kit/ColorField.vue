<script setup lang="ts">
/**
 * One named brand colour: a native picker beside the hex value, with its help
 * line or the validation error in place of it.
 */
import { isBrandHexColor } from '@owlat/shared/brandKit';

const props = defineProps<{
	id: string;
	label: string;
	help: string;
	disabled?: boolean;
}>();

const color = defineModel<string>({ required: true });
const { t } = useI18n();

const isValid = computed(() => isBrandHexColor(color.value));
const pickerValue = computed(() => (isValid.value ? expand(color.value) : '#000000'));

/** `<input type="color">` only takes #rrggbb. */
function expand(hex: string): string {
	return hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
}
</script>

<template>
	<div>
		<label :for="props.id" class="label">{{ label }}</label>
		<div class="flex items-center gap-3">
			<input
				:value="pickerValue"
				type="color"
				class="w-12 h-10 rounded-lg shadow-surface-1 cursor-pointer bg-transparent shrink-0"
				:aria-label="t('dashboard.admin.instance.brandKit.colors.pickColor', { label })"
				:disabled="disabled"
				@input="color = ($event.target as HTMLInputElement).value"
			/>
			<input
				:id="props.id"
				v-model.trim="color"
				type="text"
				placeholder="#000000"
				spellcheck="false"
				:class="['input flex-1 font-mono', !isValid && 'input-error']"
				:aria-invalid="!isValid"
				:disabled="disabled"
			/>
		</div>
		<p v-if="!isValid" class="mt-1 text-xs text-error">
			{{ t('dashboard.admin.instance.brandKit.errors.invalidColor') }}
		</p>
		<p v-else class="mt-1 text-xs text-text-tertiary">{{ help }}</p>
	</div>
</template>
