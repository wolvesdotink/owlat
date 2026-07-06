<script setup lang="ts">
/**
 * UiStatTile — the chart-kit stat: uppercase muted label, Instrument Serif
 * display numeral, optional delta line. For plain colored stat values keep
 * using UiStatCard; use this tile when the number is the hero of a chart
 * surface or sits next to sparklines/trend charts.
 */
type DeltaDirection = 'up' | 'down' | 'flat';

interface Props {
	label: string;
	value: string | number;
	delta?: string;
	deltaDirection?: DeltaDirection;
}

const props = withDefaults(defineProps<Props>(), {
	delta: undefined,
	deltaDirection: 'flat',
});

const deltaGlyph: Record<DeltaDirection, string> = {
	up: '↑',
	down: '↓',
	flat: '→',
};

const deltaClass: Record<DeltaDirection, string> = {
	up: 'text-success',
	down: 'text-error',
	flat: 'text-text-tertiary',
};

const deltaText = computed(() =>
	props.delta === undefined ? null : `${deltaGlyph[props.deltaDirection]} ${props.delta}`
);
</script>

<template>
	<div>
		<p class="text-[11px] uppercase tracking-wide text-text-tertiary">{{ label }}</p>
		<p class="mt-1 font-display text-3xl text-text-primary tabular-nums leading-none">
			{{ value }}
		</p>
		<p v-if="deltaText" :class="['mt-1.5 text-xs tabular-nums', deltaClass[deltaDirection]]">
			{{ deltaText }}
		</p>
	</div>
</template>
