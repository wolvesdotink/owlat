<script setup lang="ts">
import { ref, inject, type Ref } from 'vue';
import { Pipette } from '@lucide/vue';
import ColorSwatch from '../../ui/ColorSwatch.vue';
import { BRAND_SWATCHES_KEY } from '../../../composables/useBrandKit';

const props = defineProps<{
	value: string;
	placeholder?: string;
	/** Names the control for assistive tech; the visible label sits outside this component. */
	label?: string;
}>();

const emit = defineEmits<{
	(e: 'update', value: string): void;
}>();

const colorInputRef = ref<HTMLInputElement | null>(null);
const recentColors = inject<Ref<string[]>>('recentColors', ref([]));
// The organization's brand kit colours (useBrandKit), offered before anything else.
const brandSwatches = inject<Ref<string[]>>(BRAND_SWATCHES_KEY, ref([]));
const addRecentColor = inject<(color: string) => void>('addRecentColor', () => {});

const presetSwatches = ['#000000', '#ffffff', '#333333', '#666666', '#c4785a', 'transparent'];

function openColorPicker() {
	colorInputRef.value?.click();
}

function handleNativeColor(event: Event) {
	const color = (event.target as HTMLInputElement).value;
	emit('update', color);
	addRecentColor(color);
}

function handleTextInput(event: Event) {
	let val = (event.target as HTMLInputElement).value;
	if (val && /^[0-9a-fA-F]{3,8}$/.test(val)) {
		val = '#' + val;
	}
	emit('update', val);
}

function handleTextBlur(event: FocusEvent) {
	const val = (event.target as HTMLInputElement).value;
	if (val && val !== 'transparent') {
		addRecentColor(val);
	}
}

function selectSwatch(color: string) {
	emit('update', color);
	if (color !== 'transparent') {
		addRecentColor(color);
	}
}
</script>

<template>
	<div class="flex flex-col gap-2">
		<!-- Main: swatch + hex input + picker button -->
		<div
			class="flex items-center gap-0 border border-border-subtle rounded-lg overflow-hidden bg-bg-surface eb-input-ring"
		>
			<button
				class="w-[34px] h-[34px] border-none border-r border-r-border-subtle cursor-pointer shrink-0 p-0 transition-opacity duration-(--motion-fast) hover:opacity-85"
				:class="{ 'bg-checker': !value || value === 'transparent' }"
				:style="value && value !== 'transparent' ? { backgroundColor: value } : undefined"
				type="button"
				title="Open color picker"
				:aria-label="`Open color picker${label ? `, ${label}` : ''}`"
				@click="openColorPicker"
			/>
			<input
				type="text"
				:aria-label="label ? `${label}, hex value` : 'Hex color value'"
				class="flex-1 py-2 px-2 text-[13px] font-mono border-none bg-transparent text-text-primary outline-none min-w-0"
				:value="value"
				:placeholder="placeholder ?? '#000000'"
				spellcheck="false"
				@input="handleTextInput"
				@blur="handleTextBlur"
			/>
			<button
				class="flex items-center justify-center w-8 h-[34px] border-none border-l border-l-border-subtle bg-transparent text-text-disabled cursor-pointer shrink-0 transition-[background-color,color] duration-(--motion-fast) hover:bg-bg-surface-hover hover:text-text-secondary"
				type="button"
				title="Pick color"
				:aria-label="label ? `Pick color, ${label}` : 'Pick color'"
				@click="openColorPicker"
			>
				<Pipette :size="13" />
			</button>
			<input
				ref="colorInputRef"
				type="color"
				tabindex="-1"
				aria-hidden="true"
				class="absolute w-0 h-0 opacity-0 pointer-events-none"
				:value="value && value !== 'transparent' ? value : '#000000'"
				@input="handleNativeColor"
			/>
		</div>

		<!-- Brand kit colours first, in their own row -->
		<div
			v-if="brandSwatches.length > 0"
			class="flex items-center gap-[5px] flex-wrap"
			role="group"
			aria-label="Brand colors"
			data-testid="brand-swatches"
		>
			<span class="text-[10px] font-medium uppercase tracking-wide text-text-tertiary mr-0.5">
				Brand
			</span>
			<ColorSwatch
				v-for="color in brandSwatches"
				:key="'b-' + color"
				:color="color"
				:label="`Brand color ${color}`"
				:selected="(value ?? '').toLowerCase() === color"
				@click="selectSwatch(color)"
			/>
		</div>

		<!-- Swatches: presets, then recent colors in one row -->
		<div class="flex items-center gap-[5px] flex-wrap">
			<ColorSwatch
				v-for="color in presetSwatches"
				:key="'p-' + color"
				:color="color"
				:selected="value === color"
				@click="selectSwatch(color)"
			/>
			<template v-if="recentColors.length > 0">
				<span class="w-px h-4 bg-border-subtle mx-0.5 shrink-0" />
				<ColorSwatch
					v-for="color in recentColors.slice(0, 5)"
					:key="'r-' + color"
					:color="color"
					:selected="value === color"
					@click="selectSwatch(color)"
				/>
			</template>
		</div>
	</div>
</template>
