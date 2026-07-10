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
	// undefined omits the delta line entirely; null renders a muted, glyph-less
	// em dash (e.g. no comparable prior send) so the tile still aligns with its
	// delta-bearing peers; a string renders the directional delta.
	delta?: string | null;
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
	props.delta == null ? '—' : `${deltaGlyph[props.deltaDirection]} ${props.delta}`
);

const deltaLineClass = computed(() =>
	props.delta == null ? 'text-text-tertiary' : deltaClass[props.deltaDirection]
);
</script>

<template>
	<div>
		<p class="text-[11px] uppercase tracking-wide text-text-tertiary">{{ label }}</p>
		<p class="mt-1 font-display text-3xl text-text-primary tabular-nums leading-none">
			{{ value }}
		</p>
		<p v-if="delta !== undefined" :class="['mt-1.5 text-xs tabular-nums', deltaLineClass]">
			{{ deltaText }}
		</p>
	</div>
</template>
