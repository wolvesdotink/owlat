<script setup lang="ts">
import { useEscapeLayer } from '../../composables/useEscapeLayer';
import { placeAnchoredPanel } from '../../utils/anchoredPanelPlacement';

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
const menuStyle = ref<Record<string, string>>({});
const openSide = ref<'below' | 'above' | 'overlay'>('below');
// Only a menu taller than its room scrolls: a scroll box would clip the sides
// of its items' focus outline.
const menuScrolls = ref(false);

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

/**
 * The menu is teleported to <body> and fixed to the trigger's box, in viewport
 * coordinates. It is measured once rendered, and again whenever its size
 * changes: below the trigger when it fits, above when there is more room there,
 * capped to the room it has (scrolling inside) otherwise, and kept inside the
 * window on every edge.
 */
const MENU_GAP = 4;
const MENU_WIDTH = 176; // w-44, until the menu has rendered

/**
 * The menu's full border-box height, read from where its children are laid out
 * (their `offsetTop` counts from the menu's padding edge, which it is the offset
 * parent of as a fixed box). Neither the cap an earlier placement set nor the
 * menu's scroll position changes these, and nothing on the live menu is touched:
 * lifting its `max-height` to measure would throw away where the user had
 * scrolled it to. (`scrollHeight` is no substitute: a capped box that is not
 * yet a scroll box leaves its bottom padding out, and it never has the border.)
 */
function naturalHeight(menu: HTMLElement): number {
	const style = getComputedStyle(menu);
	const px = (value: string) => Number.parseFloat(value) || 0;
	let contentBottom = px(style.paddingTop);
	for (const child of Array.from(menu.children)) {
		if (!(child instanceof HTMLElement)) continue;
		const marginBottom = px(getComputedStyle(child).marginBottom);
		contentBottom = Math.max(contentBottom, child.offsetTop + child.offsetHeight + marginBottom);
	}
	return (
		px(style.borderTopWidth) + contentBottom + px(style.paddingBottom) + px(style.borderBottomWidth)
	);
}

const updatePosition = () => {
	const trigger = triggerRef.value;
	if (!trigger) return;
	const menu = menuRef.value;
	// 0 before the first render; placed again once the menu has a height.
	const panelHeight = menu ? naturalHeight(menu) : 0;
	const placed = placeAnchoredPanel({
		anchor: trigger.getBoundingClientRect(),
		panelHeight,
		panelWidth: menu?.offsetWidth || MENU_WIDTH,
		viewport: { width: window.innerWidth, height: window.innerHeight },
		gap: MENU_GAP,
		align: props.position === 'right' ? 'end' : 'start',
	});
	openSide.value = placed.side;
	menuStyle.value = placed.style;
	menuScrolls.value = panelHeight > Number.parseFloat(placed.style.maxHeight);
};

// Scrolling the menu itself does not move the trigger it is anchored to.
const handleScroll = (event: Event) => {
	if (menuRef.value && event.target instanceof Node && menuRef.value.contains(event.target)) return;
	updatePosition();
};

// Content that changes size while open (items that load late) moves the edge
// the placement was computed for.
let menuObserver: ResizeObserver | null = null;
watch(menuRef, (menu) => {
	menuObserver?.disconnect();
	menuObserver = null;
	if (!menu || typeof ResizeObserver === 'undefined') return;
	menuObserver = new ResizeObserver(() => updatePosition());
	menuObserver.observe(menu);
});

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

const MENU_ITEM_SELECTOR =
	'[role="menuitem"]:not([disabled]), [role="menuitemcheckbox"]:not([disabled])';

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

// Handle keyboard navigation within the dropdown
const handleKeydown = (event: KeyboardEvent) => {
	if (!isOpen.value) return;

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
		window.addEventListener('scroll', handleScroll, true);
		window.addEventListener('resize', updatePosition);

		// Auto-focus first menu item when opened via keyboard
		await nextTick();
		const firstItem = menuRef.value?.querySelector<HTMLElement>(MENU_ITEM_SELECTOR);
		firstItem?.focus();
	} else {
		document.removeEventListener('click', handleClickOutside);
		document.removeEventListener('keydown', handleKeydown);
		window.removeEventListener('scroll', handleScroll, true);
		window.removeEventListener('resize', updatePosition);
	}
});

onUnmounted(() => {
	menuObserver?.disconnect();
	document.removeEventListener('click', handleClickOutside);
	document.removeEventListener('keydown', handleKeydown);
	window.removeEventListener('scroll', handleScroll, true);
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
					:class="{ 'overflow-y-auto': menuScrolls }"
					:style="{
						...menuStyle,
						transformOrigin: openSide === 'above' ? 'bottom' : 'top',
					}"
				>
					<slot />
				</div>
			</Transition>
		</Teleport>
	</div>
</template>
