<script setup lang="ts">
/**
 * Four-sided box editor for a block's padding or margin.
 *
 * One control serves both properties: `prefix` picks the content keys
 * (`paddingTop` … / `marginTop` …) and the copy, `modes` picks which input
 * layouts the toggle offers. Values are read through `getBlockPadding` /
 * `getBlockMargin` so the defaults for absent sides live in one place.
 */
import { ref, computed } from 'vue';
import type { EditorBlock } from '../../types';
import { getBlockPadding, getBlockMargin } from '../../utils/blocks';
import NumberField from './fields/NumberField.vue';

type Mode = 'uniform' | 'axis' | 'individual';
type Side = 'Top' | 'Right' | 'Bottom' | 'Left';
type SideValues = Record<Side, number>;

const props = withDefaults(
	defineProps<{
		block: EditorBlock;
		prefix: 'padding' | 'margin';
		modes: readonly Mode[];
		max?: number;
	}>(),
	{ max: 100 }
);

const emit = defineEmits<{
	(e: 'update', key: string, value: unknown): void;
}>();

const values = computed<SideValues>(() => {
	if (props.prefix === 'padding') {
		const p = getBlockPadding(props.block);
		return {
			Top: p.paddingTop,
			Right: p.paddingRight,
			Bottom: p.paddingBottom,
			Left: p.paddingLeft,
		};
	}
	const m = getBlockMargin(props.block);
	return { Top: m.marginTop, Right: m.marginRight, Bottom: m.marginBottom, Left: m.marginLeft };
});

const MODE_HOLDS: Record<Mode, (v: SideValues) => boolean> = {
	uniform: (v) => v.Top === v.Right && v.Right === v.Bottom && v.Bottom === v.Left,
	axis: (v) => v.Top === v.Bottom && v.Left === v.Right,
	individual: () => true,
};

// The initial mode is detected once from the stored values: the first offered
// mode whose equality rule holds. After that the mode is the user's choice.
const mode = ref<Mode>(props.modes.find((m) => MODE_HOLDS[m](values.value)) ?? 'individual');

const Prefix = computed(() => (props.prefix === 'padding' ? 'Padding' : 'Margin'));

const modeTitle = (m: Mode): string => {
	if (m === 'uniform') return `Uniform ${props.prefix}`;
	if (m === 'axis') return 'Vertical & horizontal pairs';
	return 'Individual sides';
};

const key = (side: Side) => `${props.prefix}${side}`;

function emitSides(sides: readonly Side[], val: number) {
	for (const side of sides) emit('update', key(side), val);
}

// --- Mode switching ---

function setMode(newMode: Mode) {
	if (newMode === mode.value) return;

	if (newMode === 'uniform') {
		emitSides(['Right', 'Bottom', 'Left'], values.value.Top);
	} else if (newMode === 'axis') {
		emit('update', key('Bottom'), values.value.Top);
		emit('update', key('Right'), values.value.Left);
	}

	mode.value = newMode;
}

// --- Input handlers ---

const handleUniformInput = (val: number) => emitSides(['Top', 'Right', 'Bottom', 'Left'], val);
const handleVerticalInput = (val: number) => emitSides(['Top', 'Bottom'], val);
const handleHorizontalInput = (val: number) => emitSides(['Left', 'Right'], val);

function handleCompactInput(event: Event, side: Side) {
	const val = parseInt((event.target as HTMLInputElement).value) || 0;
	emit('update', key(side), Math.max(0, Math.min(props.max, val)));
}

const sides: readonly Side[] = ['Top', 'Right', 'Bottom', 'Left'];
</script>

<template>
	<div class="flex flex-col gap-2">
		<!-- Mode toggle -->
		<div class="flex items-center justify-end">
			<div
				class="inline-flex border border-border-subtle rounded-md overflow-hidden bg-bg-surface"
				role="group"
				:aria-label="`${Prefix} mode`"
			>
				<button
					v-for="(m, index) in modes"
					:key="m"
					class="flex items-center justify-center w-[26px] h-[22px] border-none cursor-pointer transition-[background-color,color] duration-(--motion-fast)"
					:class="[
						index > 0 ? 'border-l border-l-border-subtle' : '',
						mode === m
							? 'bg-brand text-white'
							: 'bg-transparent text-text-disabled hover:bg-bg-surface-hover hover:text-text-tertiary',
					]"
					type="button"
					:title="modeTitle(m)"
					:aria-label="modeTitle(m)"
					:aria-pressed="mode === m"
					@click="setMode(m)"
				>
					<!-- Uniform: solid square outline -->
					<svg v-if="m === 'uniform'" width="12" height="12" viewBox="0 0 12 12" fill="none">
						<rect
							x="1.5"
							y="1.5"
							width="9"
							height="9"
							rx="1.5"
							stroke="currentColor"
							stroke-width="1.5"
						/>
					</svg>
					<!-- Axis pairs: square with crosshair -->
					<svg v-else-if="m === 'axis'" width="12" height="12" viewBox="0 0 12 12" fill="none">
						<rect
							x="1.5"
							y="1.5"
							width="9"
							height="9"
							rx="1.5"
							stroke="currentColor"
							stroke-width="1.5"
						/>
						<line
							x1="6"
							y1="1.5"
							x2="6"
							y2="10.5"
							stroke="currentColor"
							stroke-width="1"
							opacity="0.45"
						/>
						<line
							x1="1.5"
							y1="6"
							x2="10.5"
							y2="6"
							stroke="currentColor"
							stroke-width="1"
							opacity="0.45"
						/>
					</svg>
					<!-- Individual: four separate edges -->
					<svg v-else width="12" height="12" viewBox="0 0 12 12" fill="none">
						<line
							x1="3"
							y1="1.5"
							x2="9"
							y2="1.5"
							stroke="currentColor"
							stroke-width="1.5"
							stroke-linecap="round"
						/>
						<line
							x1="10.5"
							y1="3"
							x2="10.5"
							y2="9"
							stroke="currentColor"
							stroke-width="1.5"
							stroke-linecap="round"
						/>
						<line
							x1="9"
							y1="10.5"
							x2="3"
							y2="10.5"
							stroke="currentColor"
							stroke-width="1.5"
							stroke-linecap="round"
						/>
						<line
							x1="1.5"
							y1="9"
							x2="1.5"
							y2="3"
							stroke="currentColor"
							stroke-width="1.5"
							stroke-linecap="round"
						/>
					</svg>
				</button>
			</div>
		</div>

		<!-- Uniform: single input -->
		<div v-if="mode === 'uniform'" class="flex items-center gap-2">
			<span
				class="flex items-center justify-center w-[22px] h-[22px] rounded bg-bg-surface text-[9px] font-semibold text-text-tertiary uppercase select-none shrink-0 tracking-wide"
			>
				All
			</span>
			<NumberField
				class="flex-1"
				:value="values.Top"
				:min="0"
				:max="max"
				unit="px"
				:label="`${Prefix} on all sides`"
				@update="handleUniformInput"
			/>
		</div>

		<!-- Axis pairs: V + H -->
		<template v-else-if="mode === 'axis'">
			<div class="flex items-center gap-2">
				<span
					class="flex items-center justify-center w-[22px] h-[22px] rounded bg-bg-surface text-[9px] font-semibold text-text-tertiary select-none shrink-0 tracking-wide"
					title="Vertical (top + bottom)"
				>
					V
				</span>
				<NumberField
					class="flex-1"
					:value="values.Top"
					:min="0"
					:max="max"
					unit="px"
					:label="`Vertical ${prefix}`"
					@update="handleVerticalInput"
				/>
			</div>
			<div class="flex items-center gap-2">
				<span
					class="flex items-center justify-center w-[22px] h-[22px] rounded bg-bg-surface text-[9px] font-semibold text-text-tertiary select-none shrink-0 tracking-wide"
					title="Horizontal (left + right)"
				>
					H
				</span>
				<NumberField
					class="flex-1"
					:value="values.Left"
					:min="0"
					:max="max"
					unit="px"
					:label="`Horizontal ${prefix}`"
					@update="handleHorizontalInput"
				/>
			</div>
		</template>

		<!-- Individual: compact 2×2 grid with bare inputs -->
		<template v-else>
			<div class="grid grid-cols-2 gap-2">
				<div v-for="side in sides" :key="side" class="flex flex-col gap-1">
					<span class="text-[10px] font-medium text-text-tertiary select-none">{{ side }}</span>
					<div
						class="flex items-center border border-border-subtle rounded-lg bg-bg-surface eb-input-ring"
					>
						<input
							type="number"
							:aria-label="`${side} ${prefix}`"
							class="w-full py-1.5 px-2 text-[13px] font-medium tabular-nums text-text-primary bg-transparent border-none outline-none appearance-number-plain"
							:value="values[side]"
							min="0"
							:max="max"
							@input="(e) => handleCompactInput(e, side)"
						/>
						<span class="text-[11px] font-medium text-text-tertiary pr-2 select-none shrink-0"
							>px</span
						>
					</div>
				</div>
			</div>
		</template>
	</div>
</template>
