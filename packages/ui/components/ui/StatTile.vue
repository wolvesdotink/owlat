<script setup lang="ts">
/**
 * UiStatTile — the chart-kit stat: uppercase muted label, Instrument Serif
 * display numeral, an optional day-over-day delta line, and an optional muted
 * hint (e.g. a threshold reminder like "limit 2%"). For plain colored stat
 * values keep using UiStatCard; use this tile when the number is the hero of a
 * chart surface or sits next to sparklines/trend charts.
 */
type DeltaDirection = 'up' | 'down' | 'flat';
/**
 * Whether a delta reads as good, bad, or neutral. Decoupled from the glyph
 * direction so a *falling* value can still be green (e.g. a dropping bounce
 * rate). Defaults to the intuitive up=good / down=bad when left unset.
 */
type DeltaTone = 'positive' | 'negative' | 'neutral';
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
	/** Overrides the delta colour; when unset it follows the glyph direction. */
	deltaTone?: DeltaTone;
	valueTone?: ValueTone;
	/** Muted secondary line under the value — a threshold/limit reminder. */
	hint?: string;
}

const props = withDefaults(defineProps<Props>(), {
	delta: undefined,
	deltaDirection: 'flat',
	deltaTone: undefined,
	valueTone: 'default',
	hint: undefined,
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

const deltaToneClass: Record<DeltaTone, string> = {
	positive: 'text-success',
	negative: 'text-error',
	neutral: 'text-text-tertiary',
};

// Direction drives the glyph; tone drives the colour. If no explicit tone is
// given, fall back to the intuitive up=positive / down=negative / flat=neutral.
const resolvedDeltaTone = computed<DeltaTone>(() => {
	if (props.deltaTone) return props.deltaTone;
	if (props.deltaDirection === 'up') return 'positive';
	if (props.deltaDirection === 'down') return 'negative';
	return 'neutral';
});

const deltaText = computed(() =>
	props.delta == null ? '—' : `${deltaGlyph[props.deltaDirection]} ${props.delta}`
);
</script>

<template>
	<div>
		<p class="text-[11px] uppercase tracking-wide text-text-tertiary">{{ label }}</p>
		<p :class="['mt-1 font-display text-3xl tabular-nums leading-none', valueToneClass[valueTone]]">
			{{ value }}
		</p>
		<p v-if="delta !== undefined" :class="['mt-1.5 text-xs tabular-nums', deltaToneClass[resolvedDeltaTone]]">
			{{ deltaText }}
		</p>
		<p v-if="hint" class="mt-1 text-[11px] tabular-nums text-text-tertiary">{{ hint }}</p>
	</div>
</template>
