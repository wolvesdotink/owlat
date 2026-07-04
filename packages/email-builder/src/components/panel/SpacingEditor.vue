<script setup lang="ts">
import { ref, computed, watchEffect } from 'vue';
import type { EditorBlock, CommonBlockProperties } from '../../types';
import { defaultPadding } from '../../defaults';
import NumberField from './fields/NumberField.vue';

const props = defineProps<{
	block: EditorBlock;
}>();

const emit = defineEmits<{
	(e: 'update', key: string, value: unknown): void;
}>();

const content = computed(() => props.block.content as CommonBlockProperties);

const pTop = computed(() => (content.value.paddingTop as number) ?? defaultPadding.paddingTop);
const pRight = computed(() => (content.value.paddingRight as number) ?? defaultPadding.paddingRight);
const pBottom = computed(() => (content.value.paddingBottom as number) ?? defaultPadding.paddingBottom);
const pLeft = computed(() => (content.value.paddingLeft as number) ?? defaultPadding.paddingLeft);

type Mode = 'uniform' | 'axis' | 'individual';

const userMode = ref<Mode | null>(null);
const initialized = ref(false);

// Auto-detect initial mode from current values
watchEffect(() => {
	const t = pTop.value;
	const r = pRight.value;
	const b = pBottom.value;
	const l = pLeft.value;

	if (!initialized.value) {
		initialized.value = true;
		if (t === r && r === b && b === l) {
			userMode.value = 'uniform';
		} else if (t === b && l === r) {
			userMode.value = 'axis';
		} else {
			userMode.value = 'individual';
		}
	}
});

const mode = computed<Mode>(() => userMode.value ?? 'uniform');

// --- Mode switching ---

function setMode(newMode: Mode) {
	if (newMode === mode.value) return;

	if (newMode === 'uniform') {
		const val = pTop.value;
		emit('update', 'paddingRight', val);
		emit('update', 'paddingBottom', val);
		emit('update', 'paddingLeft', val);
	} else if (newMode === 'axis') {
		emit('update', 'paddingBottom', pTop.value);
		emit('update', 'paddingRight', pLeft.value);
	}

	userMode.value = newMode;
}

// --- Input handlers ---

function handleUniformInput(val: number) {
	emit('update', 'paddingTop', val);
	emit('update', 'paddingRight', val);
	emit('update', 'paddingBottom', val);
	emit('update', 'paddingLeft', val);
}

function handleVerticalInput(val: number) {
	emit('update', 'paddingTop', val);
	emit('update', 'paddingBottom', val);
}

function handleHorizontalInput(val: number) {
	emit('update', 'paddingLeft', val);
	emit('update', 'paddingRight', val);
}

function handleCompactInput(event: Event, key: string) {
	const val = parseInt((event.target as HTMLInputElement).value) || 0;
	const clamped = Math.max(0, Math.min(100, val));
	emit('update', key, clamped);
}

const sides = [
	{ key: 'paddingTop', label: 'Top', shortLabel: 'T' },
	{ key: 'paddingRight', label: 'Right', shortLabel: 'R' },
	{ key: 'paddingBottom', label: 'Bottom', shortLabel: 'B' },
	{ key: 'paddingLeft', label: 'Left', shortLabel: 'L' },
] as const;

function sideValue(key: string): number {
	const defaults: Record<string, number> = {
		paddingTop: defaultPadding.paddingTop,
		paddingRight: defaultPadding.paddingRight,
		paddingBottom: defaultPadding.paddingBottom,
		paddingLeft: defaultPadding.paddingLeft,
	};
	return ((content.value as unknown as Record<string, unknown>)[key] as number) ?? defaults[key] ?? 0;
}
</script>

<template>
	<div class="flex flex-col gap-2">
		<!-- Mode toggle -->
		<div class="flex items-center justify-end">
			<div class="inline-flex border border-border-subtle rounded-md overflow-hidden bg-bg-surface">
				<!-- Uniform: solid square outline -->
				<button
					class="flex items-center justify-center w-[26px] h-[22px] border-none cursor-pointer transition-[background-color,color] duration-(--motion-fast)"
					:class="mode === 'uniform'
						? 'bg-brand text-white'
						: 'bg-transparent text-text-disabled hover:bg-bg-surface-hover hover:text-text-tertiary'"
					type="button"
					title="Uniform padding"
					@click="setMode('uniform')"
				>
					<svg width="12" height="12" viewBox="0 0 12 12" fill="none">
						<rect x="1.5" y="1.5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.5"/>
					</svg>
				</button>
				<!-- Axis pairs: square with crosshair -->
				<button
					class="flex items-center justify-center w-[26px] h-[22px] border-none border-l border-l-border-subtle cursor-pointer transition-[background-color,color] duration-(--motion-fast)"
					:class="mode === 'axis'
						? 'bg-brand text-white'
						: 'bg-transparent text-text-disabled hover:bg-bg-surface-hover hover:text-text-tertiary'"
					type="button"
					title="Vertical & horizontal pairs"
					@click="setMode('axis')"
				>
					<svg width="12" height="12" viewBox="0 0 12 12" fill="none">
						<rect x="1.5" y="1.5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.5"/>
						<line x1="6" y1="1.5" x2="6" y2="10.5" stroke="currentColor" stroke-width="1" opacity="0.45"/>
						<line x1="1.5" y1="6" x2="10.5" y2="6" stroke="currentColor" stroke-width="1" opacity="0.45"/>
					</svg>
				</button>
				<!-- Individual: four separate edges -->
				<button
					class="flex items-center justify-center w-[26px] h-[22px] border-none border-l border-l-border-subtle cursor-pointer transition-[background-color,color] duration-(--motion-fast)"
					:class="mode === 'individual'
						? 'bg-brand text-white'
						: 'bg-transparent text-text-disabled hover:bg-bg-surface-hover hover:text-text-tertiary'"
					type="button"
					title="Individual sides"
					@click="setMode('individual')"
				>
					<svg width="12" height="12" viewBox="0 0 12 12" fill="none">
						<line x1="3" y1="1.5" x2="9" y2="1.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
						<line x1="10.5" y1="3" x2="10.5" y2="9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
						<line x1="9" y1="10.5" x2="3" y2="10.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
						<line x1="1.5" y1="9" x2="1.5" y2="3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
					</svg>
				</button>
			</div>
		</div>

		<!-- Uniform: single input -->
		<div v-if="mode === 'uniform'" class="flex items-center gap-2">
			<span class="flex items-center justify-center w-[22px] h-[22px] rounded bg-bg-surface text-[9px] font-semibold text-text-tertiary uppercase select-none shrink-0 tracking-wide">
				All
			</span>
			<NumberField
				class="flex-1"
				:value="pTop"
				:min="0"
				:max="100"
				unit="px"
				@update="handleUniformInput"
			/>
		</div>

		<!-- Axis pairs: V + H -->
		<template v-else-if="mode === 'axis'">
			<div class="flex items-center gap-2">
				<span class="flex items-center justify-center w-[22px] h-[22px] rounded bg-bg-surface text-[9px] font-semibold text-text-tertiary select-none shrink-0 tracking-wide" title="Vertical (top + bottom)">
					V
				</span>
				<NumberField
					class="flex-1"
					:value="pTop"
					:min="0"
					:max="100"
					unit="px"
					@update="handleVerticalInput"
				/>
			</div>
			<div class="flex items-center gap-2">
				<span class="flex items-center justify-center w-[22px] h-[22px] rounded bg-bg-surface text-[9px] font-semibold text-text-tertiary select-none shrink-0 tracking-wide" title="Horizontal (left + right)">
					H
				</span>
				<NumberField
					class="flex-1"
					:value="pLeft"
					:min="0"
					:max="100"
					unit="px"
					@update="handleHorizontalInput"
				/>
			</div>
		</template>

		<!-- Individual: compact 2×2 grid with bare inputs -->
		<template v-else>
			<div class="grid grid-cols-2 gap-2">
				<div v-for="side in sides" :key="side.key" class="flex flex-col gap-1">
					<span class="text-[10px] font-medium text-text-tertiary select-none">{{ side.label }}</span>
					<div class="flex items-center border border-border-subtle rounded-lg bg-bg-surface eb-input-ring">
						<input
							type="number"
							class="w-full py-1.5 px-2 text-[13px] font-medium tabular-nums text-text-primary bg-transparent border-none outline-none appearance-number-plain"
							:value="sideValue(side.key)"
							min="0"
							max="100"
							@input="(e) => handleCompactInput(e, side.key)"
						/>
						<span class="text-[11px] font-medium text-text-tertiary pr-2 select-none shrink-0">px</span>
					</div>
				</div>
			</div>
		</template>
	</div>
</template>
