<script setup lang="ts">
type DropdownPosition = 'left' | 'right';

interface Props {
	open?: boolean;
	position?: DropdownPosition;
}

const props = withDefaults(defineProps<Props>(), {
	open: false,
	position: 'right',
});

const emit = defineEmits<{
	'update:open': [value: boolean];
}>();

const isOpen = computed({
	get: () => props.open,
	set: (value: boolean) => emit('update:open', value),
});

// Refs for positioning
const triggerRef = ref<HTMLElement | null>(null);
const menuRef = ref<HTMLElement | null>(null);
const menuPosition = ref({ top: 0, left: 0, bottom: 0 });
const openDirection = ref<'down' | 'up'>('down');

// Calculate menu position based on trigger element
const updatePosition = () => {
	if (!triggerRef.value) return;

	const rect = triggerRef.value.getBoundingClientRect();
	const viewportHeight = window.innerHeight;
	const menuHeight = 200; // Estimated menu height for positioning calculation

	// Check if there's enough space below
	const spaceBelow = viewportHeight - rect.bottom;
	const spaceAbove = rect.top;

	if (spaceBelow < menuHeight && spaceAbove > spaceBelow) {
		// Open upward
		openDirection.value = 'up';
		menuPosition.value = {
			top: rect.top + window.scrollY,
			left: props.position === 'right' ? rect.right - 176 : rect.left, // 176px = 11rem (w-44)
			bottom: viewportHeight - rect.top + 4, // 4px gap above trigger
		};
	} else {
		// Open downward
		openDirection.value = 'down';
		menuPosition.value = {
			top: rect.bottom + window.scrollY + 4, // 4px gap
			left: props.position === 'right' ? rect.right - 176 : rect.left,
			bottom: 0,
		};
	}
};

// Handle click outside
const handleClickOutside = (event: MouseEvent) => {
	const target = event.target as HTMLElement;
	if (
		menuRef.value &&
		!menuRef.value.contains(target) &&
		triggerRef.value &&
		!triggerRef.value.contains(target)
	) {
		isOpen.value = false;
	}
};

const MENU_ITEM_SELECTOR = '[role="menuitem"]:not([disabled])';

// Handle keyboard navigation within the dropdown
const handleKeydown = (event: KeyboardEvent) => {
	if (!isOpen.value) return;

	if (event.key === 'Escape') {
		isOpen.value = false;
		// Restore focus to trigger
		const trigger = triggerRef.value?.querySelector('button, [tabindex]') as HTMLElement | null;
		(trigger ?? triggerRef.value)?.focus();
		return;
	}

	if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
		event.preventDefault();
		if (!menuRef.value) return;

		const items = Array.from(menuRef.value.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR));
		if (items.length === 0) return;

		const currentIndex = items.findIndex((item) => item === document.activeElement);

		let nextIndex: number;
		if (event.key === 'ArrowDown') {
			nextIndex = currentIndex < items.length - 1 ? currentIndex + 1 : 0;
		} else {
			nextIndex = currentIndex > 0 ? currentIndex - 1 : items.length - 1;
		}
		items[nextIndex]?.focus();
		return;
	}

	if (event.key === 'Home') {
		event.preventDefault();
		const first = menuRef.value?.querySelector<HTMLElement>(MENU_ITEM_SELECTOR);
		first?.focus();
		return;
	}

	if (event.key === 'End') {
		event.preventDefault();
		const items = menuRef.value?.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR);
		items?.[items.length - 1]?.focus();
	}
};

// Toggle dropdown
const toggle = () => {
	if (!isOpen.value) {
		updatePosition();
	}
	isOpen.value = !isOpen.value;
};

// Close dropdown (exposed for child items)
const close = () => {
	isOpen.value = false;
};

// Watch for open changes to update position
watch(isOpen, (newValue) => {
	if (newValue) {
		nextTick(updatePosition);
	}
});

watch(isOpen, async (open) => {
	if (open) {
		document.addEventListener('click', handleClickOutside);
		document.addEventListener('keydown', handleKeydown);
		window.addEventListener('scroll', updatePosition, true);
		window.addEventListener('resize', updatePosition);

		// Auto-focus first menu item when opened via keyboard
		await nextTick();
		const firstItem = menuRef.value?.querySelector<HTMLElement>(MENU_ITEM_SELECTOR);
		firstItem?.focus();
	} else {
		document.removeEventListener('click', handleClickOutside);
		document.removeEventListener('keydown', handleKeydown);
		window.removeEventListener('scroll', updatePosition, true);
		window.removeEventListener('resize', updatePosition);
	}
});

onUnmounted(() => {
	document.removeEventListener('click', handleClickOutside);
	document.removeEventListener('keydown', handleKeydown);
	window.removeEventListener('scroll', updatePosition, true);
	window.removeEventListener('resize', updatePosition);
});

// Provide close function to child items
provide('dropdownClose', close);
</script>

<template>
	<div class="relative inline-block">
		<!-- Trigger -->
		<div
			ref="triggerRef"
			role="button"
			:aria-expanded="isOpen"
			aria-haspopup="menu"
			@click.stop="toggle"
		>
			<slot name="trigger" />
		</div>

		<!-- Menu (Teleported to body) -->
		<Teleport to="body">
			<Transition
				enter-active-class="duration-(--motion-moderate) ease-spring"
				enter-from-class="opacity-0 scale-95"
				enter-to-class="opacity-100 scale-100"
				leave-active-class="duration-(--motion-moderate-exit) ease-exit"
				leave-from-class="opacity-100 scale-100"
				leave-to-class="opacity-0 scale-95"
			>
				<div
					v-if="isOpen"
					ref="menuRef"
					role="menu"
					class="fixed w-44 bg-bg-elevated border border-border-subtle rounded-lg shadow-lg z-50 py-1"
					:style="{
						top: openDirection === 'up' ? 'auto' : `${menuPosition.top}px`,
						bottom: openDirection === 'up' ? `${menuPosition.bottom}px` : 'auto',
						left: `${menuPosition.left}px`,
						transformOrigin: openDirection === 'up' ? 'bottom' : 'top',
					}"
				>
					<slot />
				</div>
			</Transition>
		</Teleport>
	</div>
</template>
