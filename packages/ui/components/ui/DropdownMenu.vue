<script setup lang="ts">
import { useEscapeLayer } from '../../composables/useEscapeLayer';

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

/** The caller's own control in the trigger slot (a UiButton, mostly). */
function triggerControl(): HTMLElement | null {
	return triggerRef.value?.querySelector<HTMLElement>('button, [tabindex]') ?? null;
}

// The menu's state is announced on that control. The wrapper used to be a
// role="button" of its own around it: one control nested in another, which
// screen readers announce twice and axe reports as `nested-interactive`.
watch(
	[isOpen, triggerRef],
	() => {
		const control = triggerControl();
		if (!control) return;
		control.setAttribute('aria-haspopup', 'menu');
		control.setAttribute('aria-expanded', String(isOpen.value));
	},
	{ immediate: true, flush: 'post' }
);

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

const ITEM_ROLES = ['menuitem', 'menuitemcheckbox', 'menuitemradio'];
/** Any item, disabled or not: the keys it gets are the menu's. */
const ITEM_SELECTOR = ITEM_ROLES.map((role) => `[role="${role}"]`).join(', ');
/** The items focus moves between. */
const MENU_ITEM_SELECTOR = ITEM_ROLES.map(
	(role) => `[role="${role}"]:not([disabled]):not([aria-disabled="true"])`
).join(', ');

/**
 * Escape closes the menu and nothing else: not a surrounding dialog, and not
 * the page's own Escape action (e.g. leave Browse in Mail, which unmounts its
 * folder navigation).
 */
useEscapeLayer(isOpen, () => {
	isOpen.value = false;
	// Restore focus to trigger
	(triggerControl() ?? triggerRef.value)?.focus();
});

/**
 * Keys pressed inside the menu, and only there: a dialog opened over it, or
 * anything else holding focus, keeps its keys. It listens on the window in the
 * capture phase, so Tab reaches it before a surrounding dialog's focus trap.
 */
const handleKeydown = (event: KeyboardEvent) => {
	const menu = menuRef.value;
	const target = event.target as HTMLElement | null;
	if (!isOpen.value || !menu || !target || !menu.contains(target)) return;

	// Tab leaves the menu and closes it. The press is not prevented: from the
	// trigger, where the menu belongs in the page, the browser moves focus on
	// to the next (or previous) control as it would anyway. The menu itself is
	// teleported to the end of <body>, so from there Tab would leave the page.
	if (event.key === 'Tab') {
		triggerControl()?.focus();
		isOpen.value = false;
		return;
	}

	// Arrows, Home and End move between the items. A field or other widget in
	// the menu keeps them for itself (the caret, its own options).
	if (!target.matches(ITEM_SELECTOR)) return;
	const items = Array.from(menu.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR));
	const currentIndex = items.indexOf(target);
	let next: HTMLElement | undefined;
	if (event.key === 'ArrowDown') {
		next = items[currentIndex < items.length - 1 ? currentIndex + 1 : 0];
	} else if (event.key === 'ArrowUp') {
		next = items[currentIndex > 0 ? currentIndex - 1 : items.length - 1];
	} else if (event.key === 'Home') {
		next = items[0];
	} else if (event.key === 'End') {
		next = items.at(-1);
	} else {
		return;
	}
	event.preventDefault();
	next?.focus();
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
		window.addEventListener('keydown', handleKeydown, true);
		window.addEventListener('scroll', updatePosition, true);
		window.addEventListener('resize', updatePosition);

		// The first enabled item takes focus on open, opened by pointer or key.
		await nextTick();
		const firstItem = menuRef.value?.querySelector<HTMLElement>(MENU_ITEM_SELECTOR);
		firstItem?.focus();
	} else {
		document.removeEventListener('click', handleClickOutside);
		window.removeEventListener('keydown', handleKeydown, true);
		window.removeEventListener('scroll', updatePosition, true);
		window.removeEventListener('resize', updatePosition);
	}
});

onUnmounted(() => {
	document.removeEventListener('click', handleClickOutside);
	window.removeEventListener('keydown', handleKeydown, true);
	window.removeEventListener('scroll', updatePosition, true);
	window.removeEventListener('resize', updatePosition);
});

// Provide close function to child items
provide('dropdownClose', close);
</script>

<template>
	<div class="relative inline-block">
		<!-- Trigger -->
		<div ref="triggerRef" @click.stop="toggle">
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
