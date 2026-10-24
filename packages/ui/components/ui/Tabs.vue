<script setup lang="ts">
import { selectedTabValue, tabElementId, type UiTabOption } from '../../utils/tabs';

interface Props {
	tabs: UiTabOption[];
	modelValue?: string;
	/**
	 * Id of the one panel the caller renders for the selected tab (see
	 * utils/tabs.ts); every tab controls it. Without it the tabs claim no
	 * panel: no `aria-controls`.
	 */
	panelId?: string;
}

const props = defineProps<Props>();

const emit = defineEmits<{
	'update:modelValue': [value: string];
}>();

// Generate unique ID for accessibility
const tabsId = useId();

// One fallback for markup and keys alike: no (or an unknown) modelValue
// selects the first tab, so exactly one tab is tabbable.
const selectedValue = computed(() => selectedTabValue(props.tabs, props.modelValue));

// Get the index of the currently selected tab
const selectedIndex = computed(() => {
	const index = props.tabs.findIndex((tab) => tab.value === selectedValue.value);
	return index >= 0 ? index : 0;
});

const tabId = (tab: UiTabOption, index: number) =>
	props.panelId ? tabElementId(props.panelId, tab.value) : `${tabsId}-tab-${index}`;

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
	<!-- Scrolls instead of widening the page when the tabs outgrow a phone. -->
	<div
		role="tablist"
		class="flex max-w-full gap-1 overflow-x-auto rounded-lg bg-bg-surface p-1"
		@keydown="handleKeyDown"
	>
		<button
			v-for="(tab, index) in tabs"
			:ref="setButtonRef(index)"
			:id="tabId(tab, index)"
			:key="tab.value"
			type="button"
			role="tab"
			:aria-selected="selectedValue === tab.value"
			:aria-controls="panelId || undefined"
			:tabindex="selectedValue === tab.value ? 0 : -1"
			:class="[
				'shrink-0 whitespace-nowrap px-3 py-1.5 rounded-md text-sm font-medium transition-[color,background-color,box-shadow] duration-(--motion-moderate) ease-spring',
				selectedValue === tab.value
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
