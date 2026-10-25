<script setup lang="ts">
import UiTooltip from '@owlat/ui/components/ui/Tooltip.vue';
import { computed, ref } from 'vue';
import type { GradientBackground } from '../../types';
import {
	Plus,
	X,
	Trash2,
	ArrowRight,
	ArrowLeft,
	ArrowDown,
	ArrowUp,
	ArrowDownRight,
} from '@lucide/vue';
import ButtonGroup from '../ui/ButtonGroup.vue';
import IconButton from '../ui/IconButton.vue';
import ActionButton from '../ui/ActionButton.vue';
import { useBuilderI18n } from '../../i18n/useBuilderI18n';

const { t } = useBuilderI18n();

const props = defineProps<{
	modelValue?: GradientBackground;
}>();

const emit = defineEmits<{
	(e: 'update:modelValue', value: GradientBackground | undefined): void;
}>();

const isEnabled = computed(() => !!props.modelValue);

const directionOptions = computed(() => [
	{ label: t('builder.panel.gradient.right'), value: 'to right', icon: ArrowRight },
	{ label: t('builder.panel.gradient.left'), value: 'to left', icon: ArrowLeft },
	{ label: t('builder.panel.gradient.down'), value: 'to bottom', icon: ArrowDown },
	{ label: t('builder.panel.gradient.up'), value: 'to top', icon: ArrowUp },
	{ label: '135°', value: '135deg', icon: ArrowDownRight },
]);

const sortedStops = computed(() => {
	if (!props.modelValue) return [];
	return props.modelValue.stops.slice().sort((a, b) => a.position - b.position);
});

const previewStyle = computed(() => {
	if (!props.modelValue || sortedStops.value.length < 2) return {};
	const stops = sortedStops.value.map((s) => `${s.color} ${s.position}%`).join(', ');
	return {
		background: `linear-gradient(${props.modelValue.direction}, ${stops})`,
	};
});

const gradientTrackStyle = computed(() => {
	if (!props.modelValue || props.modelValue.stops.length < 2) return '';
	const stops = props.modelValue.stops
		.slice()
		.sort((a, b) => a.position - b.position)
		.map((s) => `${s.color} ${s.position}%`)
		.join(', ');
	return `linear-gradient(to right, ${stops})`;
});

const sortedMarkers = computed(() => {
	if (!props.modelValue) return [];
	return props.modelValue.stops
		.map((s, i) => ({ position: s.position, color: s.color, index: i }))
		.sort((a, b) => a.position - b.position);
});

function enable() {
	emit('update:modelValue', {
		direction: 'to right',
		stops: [
			{ color: '#c4785a', position: 0 },
			{ color: '#7a9b6e', position: 100 },
		],
	});
}

function clear() {
	emit('update:modelValue', undefined);
}

function updateDirection(direction: string) {
	if (!props.modelValue) return;
	emit('update:modelValue', { ...props.modelValue, direction });
}

function emitStops(stops: GradientBackground['stops']) {
	if (!props.modelValue) return;
	const sorted = stops.slice().sort((a, b) => a.position - b.position);
	emit('update:modelValue', { ...props.modelValue, stops: sorted });
}

function updateStopColor(index: number, color: string) {
	if (!props.modelValue) return;
	const stops = [...props.modelValue.stops];
	stops[index] = { ...stops[index]!, color };
	emitStops(stops);
}

function updateStopPosition(index: number, position: number) {
	if (!props.modelValue) return;
	const clamped = Math.max(0, Math.min(100, position));
	const stops = [...props.modelValue.stops];
	stops[index] = { ...stops[index]!, position: clamped };
	emitStops(stops);
}

function addStop() {
	if (!props.modelValue) return;
	emitStops([...props.modelValue.stops, { color: '#ffffff', position: 50 }]);
}

function removeStop(index: number) {
	if (!props.modelValue || props.modelValue.stops.length <= 2) return;
	emitStops(props.modelValue.stops.filter((_, i) => i !== index));
}

const colorInputRefs = ref<Record<number, HTMLInputElement | null>>({});

function openColorPicker(index: number) {
	colorInputRefs.value[index]?.click();
}
</script>

<template>
	<div class="flex flex-col gap-1.5">
		<div v-if="!isEnabled">
			<ActionButton :label="t('builder.panel.gradient.enable')" class="w-full" @click="enable" />
		</div>

		<template v-else>
			<!-- Preview bar with position markers -->
			<div class="flex flex-col">
				<div
					class="h-8 rounded-md border border-border-subtle shadow-[inset_0_1px_2px_rgba(0,0,0,0.2)]"
					:style="previewStyle"
				/>
				<!-- Position markers -->
				<div class="relative h-2.5 mx-1">
					<div
						v-for="marker in sortedMarkers"
						:key="marker.index"
						class="absolute top-0 w-0 h-0 border-l-[4px] border-r-[4px] border-t-[5px] border-l-transparent border-r-transparent border-t-text-tertiary -translate-x-1/2"
						:style="{ left: `${marker.position}%` }"
					/>
				</div>
			</div>

			<!-- Direction -->
			<div class="flex">
				<ButtonGroup
					:label="t('builder.panel.gradient.direction')"
					:options="directionOptions"
					:value="modelValue?.direction ?? 'to right'"
					@update="updateDirection"
				/>
			</div>

			<!-- Stops -->
			<div class="flex flex-col gap-1">
				<div
					v-for="(stop, index) in modelValue?.stops ?? []"
					:key="index"
					class="flex items-center gap-1.5 rounded-md border border-border-subtle bg-bg-surface px-1.5 py-1"
				>
					<!-- Color swatch with hidden color input -->
					<div class="relative shrink-0">
						<UiTooltip :text="stop.color">
							<button
								class="w-[22px] h-[22px] rounded-[5px] border-[1.5px] border-border-subtle cursor-pointer p-0 transition-[transform,box-shadow] duration-(--motion-moderate) hover:scale-[1.12] hover:border-text-tertiary"
								:style="{ backgroundColor: stop.color }"
								:aria-label="
									t('builder.panel.gradient.stopColorValue', {
										index: index + 1,
										color: stop.color,
									})
								"
								type="button"
								@click="openColorPicker(index)"
							/>
						</UiTooltip>
						<input
							:ref="
								(el) => {
									colorInputRefs[index] = el as HTMLInputElement;
								}
							"
							type="color"
							:aria-label="t('builder.panel.gradient.stopColor', { index: index + 1 })"
							class="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
							:value="stop.color"
							@input="(e) => updateStopColor(index, (e.target as HTMLInputElement).value)"
						/>
					</div>

					<!-- Range slider with gradient track -->
					<input
						type="range"
						:aria-label="t('builder.panel.gradient.stopPosition', { index: index + 1 })"
						class="gradient-range flex-1 h-4 cursor-pointer"
						:style="{ '--gradient-track': gradientTrackStyle }"
						:value="stop.position"
						min="0"
						max="100"
						@input="
							(e) => updateStopPosition(index, parseInt((e.target as HTMLInputElement).value) || 0)
						"
					/>

					<!-- Number input + % -->
					<div class="flex items-center shrink-0">
						<input
							type="number"
							:aria-label="t('builder.panel.gradient.stopPercent', { index: index + 1 })"
							class="w-11 py-[3px] px-0.5 text-xs tabular-nums text-right border-none border-b border-b-transparent bg-transparent text-text-primary outline-none appearance-number-plain transition-[border-color] duration-(--motion-fast) hover:border-b-border-subtle focus:border-b-brand"
							:value="stop.position"
							min="0"
							max="100"
							@input="
								(e) =>
									updateStopPosition(index, parseInt((e.target as HTMLInputElement).value) || 0)
							"
						/>
						<span class="text-[11px] text-text-tertiary select-none">%</span>
					</div>

					<!-- Remove button -->
					<IconButton
						v-if="(modelValue?.stops.length ?? 0) > 2"
						:icon="Trash2"
						:title="t('builder.panel.gradient.removeStop')"
						:aria-label="t('builder.panel.gradient.removeStopIndex', { index: index + 1 })"
						size="sm"
						variant="destructive"
						@click="removeStop(index)"
					/>
				</div>
			</div>

			<!-- Footer actions -->
			<div class="flex gap-1.5">
				<ActionButton
					:icon="Plus"
					:label="t('builder.panel.gradient.addStop')"
					variant="subtle"
					@click="addStop"
				/>
				<ActionButton
					:icon="X"
					:label="t('builder.panel.gradient.clear')"
					variant="subtle"
					@click="clear"
				/>
			</div>
		</template>
	</div>
</template>

<style scoped>
/* Custom range slider matching the panel theme */
.gradient-range {
	-webkit-appearance: none;
	appearance: none;
	background: transparent;
}

.gradient-range::-webkit-slider-runnable-track {
	height: 6px;
	border-radius: 3px;
	background: var(--gradient-track, var(--color-bg-surface));
	border: 1px solid var(--color-border-subtle);
}

.gradient-range::-moz-range-track {
	height: 6px;
	border-radius: 3px;
	background: var(--gradient-track, var(--color-bg-surface));
	border: 1px solid var(--color-border-subtle);
}

.gradient-range::-webkit-slider-thumb {
	-webkit-appearance: none;
	width: 14px;
	height: 14px;
	border-radius: 50%;
	background: white;
	border: 2px solid var(--color-border-subtle);
	margin-top: -5px;
	box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
	cursor: pointer;
	transition: transform var(--motion-fast) var(--ease-spring);
}

.gradient-range::-moz-range-thumb {
	width: 14px;
	height: 14px;
	border-radius: 50%;
	background: white;
	border: 2px solid var(--color-border-subtle);
	box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
	cursor: pointer;
}

.gradient-range::-webkit-slider-thumb:hover {
	transform: scale(1.15);
}
</style>
