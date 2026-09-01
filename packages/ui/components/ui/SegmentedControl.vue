<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch, nextTick } from 'vue';

interface SegmentOption {
	value: string;
	label: string;
	disabled?: boolean;
}

type SegmentSize = 'sm' | 'md';

interface Props {
	options: SegmentOption[];
	modelValue?: string;
	size?: SegmentSize;
}

const props = withDefaults(defineProps<Props>(), {
	size: 'md',
});

const emit = defineEmits<{
	'update:modelValue': [value: string];
}>();

const selectedIndex = computed(() => {
	const index = props.options.findIndex((o) => o.value === props.modelValue);
	return index >= 0 ? index : 0;
});

const select = (option: SegmentOption) => {
	if (option.disabled || option.value === props.modelValue) return;
	emit('update:modelValue', option.value);
};

const tabButtonRefs = shallowRef<HTMLButtonElement[]>([]);

const setButtonRef = (index: number) => (el: unknown) => {
	if (el) tabButtonRefs.value[index] = el as HTMLButtonElement;
};

const handleKeyDown = (event: KeyboardEvent) => {
	const current = selectedIndex.value;
	let next: number | null = null;

	switch (event.key) {
		case 'ArrowLeft':
			event.preventDefault();
			next = current > 0 ? current - 1 : props.options.length - 1;
			break;
		case 'ArrowRight':
			event.preventDefault();
			next = current < props.options.length - 1 ? current + 1 : 0;
			break;
		case 'Home':
			event.preventDefault();
			next = 0;
			break;
		case 'End':
			event.preventDefault();
			next = props.options.length - 1;
			break;
	}

	if (next !== null) {
		const option = props.options[next];
		if (option && !option.disabled) {
			select(option);
			tabButtonRefs.value[next]?.focus();
		}
	}
};

/**
 * The sliding highlight is MEASURED off the selected button rather than
 * computed as `100 / options.length`.
 *
 * The track is `repeat(N, 1fr)`, and `1fr` is `minmax(auto, 1fr)`: a label wider
 * than its equal share (Conversations next to Flat) grows its column and shrinks
 * the others. An indicator sized at a flat 1/N of the track then runs past the
 * short first segment and paints over the next label — the exact defect this
 * replaces. Reading `offsetLeft`/`offsetWidth` costs one layout read per change
 * and is correct for any label lengths, in any locale, at any font size.
 */
const measured = ref<{ left: number; width: number } | null>(null);
const rootRef = ref<HTMLElement | null>(null);

/**
 * The track's inset, in px, shared by the stylesheet and the pre-measure
 * fallback below. One number rather than two: the fallback's first column has
 * to start exactly where `.segmented-control`'s padding puts the first button,
 * or the indicator jumps by that difference on mount.
 */
const TRACK_PADDING = 4;

function measure() {
	const button = tabButtonRefs.value[selectedIndex.value];
	// `offsetWidth === 0` means the control is display:none or not laid out yet
	// (and, in jsdom/happy-dom, that there is no layout at all): keep the
	// analytical fallback rather than collapsing the indicator to nothing.
	if (!button || button.offsetWidth === 0) {
		measured.value = null;
		return;
	}
	measured.value = { left: button.offsetLeft, width: button.offsetWidth };
}

let observer: ResizeObserver | null = null;

onMounted(() => {
	measure();
	// The track resizes with its container (and with a late webfont swap), which
	// moves every column boundary the indicator is pinned to.
	if (typeof ResizeObserver !== 'undefined' && rootRef.value) {
		observer = new ResizeObserver(() => measure());
		observer.observe(rootRef.value);
	}
});

onBeforeUnmount(() => {
	observer?.disconnect();
	observer = null;
});

watch([selectedIndex, () => props.options], () => void nextTick(measure));

const indicatorStyle = computed(() => {
	const geometry = measured.value;
	if (geometry) return { left: `${geometry.left}px`, width: `${geometry.width}px` };
	// Pre-measure (SSR's first paint) fallback: equal columns, offset by the
	// track padding. Replaced by the measured geometry on mount.
	const share = 100 / props.options.length;
	const offset = selectedIndex.value * TRACK_PADDING;
	return {
		left: `${TRACK_PADDING}px`,
		width: `calc(${share}% - ${TRACK_PADDING}px)`,
		transform: `translateX(calc(${selectedIndex.value * 100}% + ${offset}px))`,
	};
});
</script>

<template>
	<div
		ref="rootRef"
		role="tablist"
		class="segmented-control"
		:class="`segmented-control--${size}`"
		@keydown="handleKeyDown"
	>
		<span class="segmented-control__indicator" :style="indicatorStyle" />
		<button
			v-for="(option, index) in options"
			:ref="setButtonRef(index)"
			:key="option.value"
			type="button"
			role="tab"
			:aria-selected="modelValue === option.value"
			:tabindex="modelValue === option.value ? 0 : -1"
			:disabled="option.disabled"
			class="segmented-control__btn"
			:class="{ 'segmented-control__btn--active': modelValue === option.value }"
			@click="select(option)"
		>
			<slot :name="`option-${option.value}`" :option="option" :active="modelValue === option.value">
				{{ option.label }}
			</slot>
		</button>
	</div>
</template>

<style scoped>
.segmented-control {
	position: relative;
	display: grid;
	grid-template-columns: v-bind('`repeat(${options.length}, 1fr)`');
	background: var(--surface-2);
	/* Rule 2 — elevation is a shadow ring, never a painted border. The old rule
	   was `1px solid var(--color-border, #e5e7eb)`, and `--color-border` has
	   never existed in the token set, so the hex fallback always won and every
	   segmented control drew a literal grey-200 hairline in BOTH themes. Hex
	   fallbacks are gone throughout this block for the same reason: a fallback
	   here is a theme-locked value that only shows up when a token is renamed. */
	box-shadow: var(--shadow-1);
	/* Pill, like every other chip in the design language. */
	border-radius: 9999px;
	padding: 4px;
}

/* `left`/`width` (and, before the first measurement, `transform`) are supplied
   inline from the measured geometry — see `indicatorStyle`. */
.segmented-control__indicator {
	position: absolute;
	top: 4px;
	height: calc(100% - 8px);
	/* Monochrome selection: one step up the ladder plus a ring, the same recipe
	   as `.btn-secondary`. It used to be a solid `--color-brand` fill, i.e. a
	   terracotta nav pill — the smell DESIGN-LANGUAGE.md §5 names first. */
	background: var(--surface-3);
	border-radius: 9999px;
	transition:
		left var(--motion-moderate) var(--ease-spring),
		width var(--motion-moderate) var(--ease-spring),
		transform var(--motion-moderate) var(--ease-spring);
	z-index: 0;
	box-shadow: var(--shadow-2);
}

.segmented-control__btn {
	position: relative;
	z-index: 1;
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 4px;
	font-size: var(--text-caption);
	line-height: 1;
	border: none;
	background: transparent;
	border-radius: 9999px;
	color: var(--color-text-secondary);
	cursor: pointer;
	transition:
		color var(--motion-fast) var(--ease-spring),
		font-weight var(--motion-fast) var(--ease-spring);
	white-space: nowrap;
}

.segmented-control--sm .segmented-control__btn {
	padding: 4px 8px;
	font-size: var(--text-2xs);
}

.segmented-control--md .segmented-control__btn {
	padding: 4px 12px;
}

.segmented-control__btn:hover:not(.segmented-control__btn--active):not(:disabled) {
	color: var(--color-text-primary);
}

/* Rule 3 — the selected segment is carried by weight and text colour, not by
   an inverse label on a coloured chip. */
.segmented-control__btn--active {
	color: var(--color-text-primary);
	font-weight: var(--font-weight-medium);
}

.segmented-control__btn:disabled {
	opacity: 0.5;
	cursor: not-allowed;
}
</style>
