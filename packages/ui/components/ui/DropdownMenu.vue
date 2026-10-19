<script setup lang="ts">
import { useEscapeLayer } from '../../composables/useEscapeLayer';
import { fitsWithin, placeAnchoredPanel } from '../../utils/anchoredPanelPlacement';

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
// The menu's content, never height-capped, so its height is the menu's own.
const contentRef = ref<HTMLElement | null>(null);
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
 * coordinates. It is measured once rendered, and again whenever its size can
 * have changed: below the trigger when it fits, above when there is more room
 * there, capped to the room it has (scrolling inside) otherwise, and kept
 * inside the window on every edge.
 */
const MENU_GAP = 4;
const MENU_WIDTH = 176; // w-44, until the menu has rendered

/**
 * The menu's full border-box height: its content box, which is never capped,
 * plus the menu's own padding and border. Only reads layout, so it neither
 * moves where the menu is scrolled to nor touches anything in it, and whatever
 * the browser lays out inside the content (wrappers, hidden children, margins)
 * counts exactly as shown.
 *
 * In fractional CSS pixels throughout: at a fractional zoom or device scale
 * the boxes are not whole pixels, and a rounded `offsetHeight` next to a
 * fractional border overshoots a menu that fits. The content's computed
 * height is its used height, unaffected by the opening scale transition
 * (unlike `getBoundingClientRect`); `offsetHeight` stands in only where there
 * is no layout to resolve it.
 */
function measureMenu(menu: HTMLElement, content: HTMLElement): number {
	const style = getComputedStyle(menu);
	const px = (value: string) => Number.parseFloat(value) || 0;
	const contentHeight = Number.parseFloat(getComputedStyle(content).height);
	return (
		(Number.isFinite(contentHeight) ? contentHeight : content.offsetHeight) +
		px(style.paddingTop) +
		px(style.paddingBottom) +
		px(style.borderTopWidth) +
		px(style.borderBottomWidth)
	);
}

// The last measured height. A scroll only moves the trigger, so it re-places
// the menu with this; opening, the menu's own resize and a window resize
// measure again first.
let menuHeight = 0;

const placeMenu = () => {
	const trigger = triggerRef.value;
	if (!trigger) return;
	const placed = placeAnchoredPanel({
		anchor: trigger.getBoundingClientRect(),
		panelHeight: menuHeight,
		panelWidth: menuRef.value?.offsetWidth || MENU_WIDTH,
		viewport: { width: window.innerWidth, height: window.innerHeight },
		gap: MENU_GAP,
		align: props.position === 'right' ? 'end' : 'start',
	});
	openSide.value = placed.side;
	menuScrolls.value = !fitsWithin(menuHeight, placed.room);
	// Only a menu that scrolls is capped. The cap is whole pixels, and a menu
	// that fits its room to within the snapping tolerance would lose its last
	// fraction of a pixel to it.
	const { maxHeight, ...uncapped } = placed.style;
	menuStyle.value = menuScrolls.value ? { ...uncapped, maxHeight } : uncapped;
};

const measureAndPlaceMenu = () => {
	// 0 before the first render; measured again once the menu has rendered.
	const menu = menuRef.value;
	const content = contentRef.value;
	menuHeight = menu && content ? measureMenu(menu, content) : 0;
	placeMenu();
};

// Scrolling the menu itself does not move the trigger it is anchored to.
const handleScroll = (event: Event) => {
	if (menuRef.value && event.target instanceof Node && menuRef.value.contains(event.target)) return;
	placeMenu();
};

// Content that changes size while open (items that load late) moves the edge
// the placement was computed for. Observed on the content, which grows even
// when the menu around it is already at its cap.
let menuObserver: ResizeObserver | null = null;
watch(contentRef, (content) => {
	menuObserver?.disconnect();
	menuObserver = null;
	if (!content || typeof ResizeObserver === 'undefined') return;
	menuObserver = new ResizeObserver(() => measureAndPlaceMenu());
	menuObserver.observe(content);
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
		measureAndPlaceMenu();
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
		nextTick(measureAndPlaceMenu);
	}
});

watch(isOpen, async (open) => {
	if (open) {
		document.addEventListener('click', handleClickOutside);
		document.addEventListener('keydown', handleKeydown);
		window.addEventListener('scroll', handleScroll, true);
		window.addEventListener('resize', measureAndPlaceMenu);

		// Auto-focus first menu item when opened via keyboard
		await nextTick();
		const firstItem = menuRef.value?.querySelector<HTMLElement>(MENU_ITEM_SELECTOR);
		firstItem?.focus();
	} else {
		document.removeEventListener('click', handleClickOutside);
		document.removeEventListener('keydown', handleKeydown);
		window.removeEventListener('scroll', handleScroll, true);
		window.removeEventListener('resize', measureAndPlaceMenu);
	}
});

onUnmounted(() => {
	menuObserver?.disconnect();
	document.removeEventListener('click', handleClickOutside);
	document.removeEventListener('keydown', handleKeydown);
	window.removeEventListener('scroll', handleScroll, true);
	window.removeEventListener('resize', measureAndPlaceMenu);
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
					<!-- flow-root keeps the first and last child's margins inside, where
					     the menu's padding kept them, so they count in its height. -->
					<div ref="contentRef" class="flow-root">
						<slot />
					</div>
				</div>
			</Transition>
		</Teleport>
	</div>
</template>
