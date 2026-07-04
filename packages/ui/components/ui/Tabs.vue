<script setup lang="ts">
interface TabOption {
	value: string;
	label: string;
	count?: number;
}

interface Props {
	tabs: TabOption[];
	modelValue?: string;
}

const props = defineProps<Props>();

const emit = defineEmits<{
	'update:modelValue': [value: string];
}>();

// Generate unique ID for accessibility
const tabsId = useId();

// Get the index of the currently selected tab
const selectedIndex = computed(() => {
	const index = props.tabs.findIndex((tab) => tab.value === props.modelValue);
	return index >= 0 ? index : 0;
});

// Handle tab selection
const selectTab = (value: string) => {
	emit('update:modelValue', value);
};

// Template refs for tab buttons
const tabButtonRefs = shallowRef<HTMLButtonElement[]>([]);

const setButtonRef = (index: number) => (el: unknown) => {
	if (el) tabButtonRefs.value[index] = el as HTMLButtonElement;
};

// Handle keyboard navigation
const handleKeyDown = (event: KeyboardEvent) => {
	const currentIndex = selectedIndex.value;
	let newIndex: number | null = null;

	switch (event.key) {
		case 'ArrowLeft':
		case 'ArrowUp':
			event.preventDefault();
			newIndex = currentIndex > 0 ? currentIndex - 1 : props.tabs.length - 1;
			break;
		case 'ArrowRight':
		case 'ArrowDown':
			event.preventDefault();
			newIndex = currentIndex < props.tabs.length - 1 ? currentIndex + 1 : 0;
			break;
		case 'Home':
			event.preventDefault();
			newIndex = 0;
			break;
		case 'End':
			event.preventDefault();
			newIndex = props.tabs.length - 1;
			break;
	}

	if (newIndex !== null) {
		const newTab = props.tabs[newIndex];
		if (newTab) {
			selectTab(newTab.value);
			tabButtonRefs.value[newIndex]?.focus();
		}
	}
};
</script>

<template>
	<div role="tablist" class="flex bg-bg-surface rounded-lg p-1 gap-1" @keydown="handleKeyDown">
		<button
			v-for="(tab, index) in tabs"
			:ref="setButtonRef(index)"
			:id="`${tabsId}-tab-${index}`"
			:key="tab.value"
			type="button"
			role="tab"
			:aria-selected="modelValue === tab.value"
			:aria-controls="`${tabsId}-panel-${index}`"
			:tabindex="modelValue === tab.value ? 0 : -1"
			:class="[
				'px-3 py-1.5 rounded-md text-sm font-medium transition-all duration-(--motion-moderate) ease-spring',
				modelValue === tab.value
					? 'bg-bg-elevated text-text-primary shadow-sm'
					: 'text-text-secondary hover:text-text-primary',
			]"
			@click="selectTab(tab.value)"
		>
			{{ tab.label }}
			<span v-if="tab.count !== undefined" class="ml-1.5 text-xs text-text-tertiary">
				({{ tab.count }})
			</span>
		</button>
	</div>
</template>
