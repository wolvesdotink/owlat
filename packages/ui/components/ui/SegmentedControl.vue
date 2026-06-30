<script setup lang="ts">
import { computed, shallowRef } from 'vue';

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

const indicatorStyle = computed(() => {
	const count = props.options.length;
	const width = 100 / count;
	return {
		width: `calc(${width}% - 3px)`,
		transform: `translateX(calc(${selectedIndex.value * 100}% + ${selectedIndex.value * 3}px))`,
	};
});
</script>

<template>
	<div
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
	grid-template-columns: v-bind("`repeat(${options.length}, 1fr)`");
	background: var(--color-bg-surface, #f3f4f6);
	border: 1px solid var(--color-border, #e5e7eb);
	border-radius: 8px;
	padding: 3px;
}

.segmented-control__indicator {
	position: absolute;
	top: 3px;
	left: 3px;
	height: calc(100% - 6px);
	background: var(--color-brand, #c4785a);
	border-radius: 5px;
	transition: transform 200ms cubic-bezier(0.4, 0, 0.2, 1);
	z-index: 0;
	box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
}

.segmented-control__btn {
	position: relative;
	z-index: 1;
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 5px;
	font-size: 13px;
	line-height: 1;
	border: none;
	background: transparent;
	border-radius: 5px;
	color: var(--color-text-secondary, #6b7280);
	cursor: pointer;
	transition: color 150ms ease;
	white-space: nowrap;
}

.segmented-control--sm .segmented-control__btn {
	padding: 4px 10px;
	font-size: 12px;
}

.segmented-control--md .segmented-control__btn {
	padding: 5px 12px;
}

.segmented-control__btn:hover:not(.segmented-control__btn--active):not(:disabled) {
	color: var(--color-text-primary, #111827);
}

.segmented-control__btn--active {
	color: var(--color-text-inverse, #fff);
	font-weight: 500;
}

.segmented-control__btn:disabled {
	opacity: 0.5;
	cursor: not-allowed;
}
</style>
