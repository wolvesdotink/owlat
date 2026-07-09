<script setup lang="ts">
/**
 * UiStatTile — the chart-kit stat: uppercase muted label, Instrument Serif
 * display numeral, optional delta line. For plain colored stat values keep
 * using UiStatCard; use this tile when the number is the hero of a chart
 * surface or sits next to sparklines/trend charts.
 */
type DeltaDirection = 'up' | 'down' | 'flat';
/** Semantic tint for the value numeral. Default keeps the primary text colour. */
type ValueTone = 'default' | 'success' | 'warning' | 'error';

interface Props {
	label: string;
	value: string | number;
	// undefined omits the delta line entirely; null renders a muted, glyph-less
	// em dash (e.g. no comparable prior send) so the tile still aligns with its
	// delta-bearing peers; a string renders the directional delta.
	delta?: string | null;
	deltaDirection?: DeltaDirection;
	valueTone?: ValueTone;
}

const props = withDefaults(defineProps<Props>(), {
	delta: undefined,
	deltaDirection: 'flat',
	valueTone: 'default',
});

const valueToneClass: Record<ValueTone, string> = {
	default: 'text-text-primary',
	success: 'text-success',
	warning: 'text-warning',
	error: 'text-error',
};

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
		<p :class="['mt-1 font-display text-3xl tabular-nums leading-none', valueToneClass[valueTone]]">
			{{ value }}
		</p>
		<p v-if="delta !== undefined" :class="['mt-1.5 text-xs tabular-nums', deltaLineClass]">
			{{ deltaText }}
		</p>
	</div>
</template>
