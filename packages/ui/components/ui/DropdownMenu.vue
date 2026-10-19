<script setup lang="ts">
import { tabbableIn } from '../../utils/tabbable';
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

const ITEM_SELECTOR = ['menuitem', 'menuitemcheckbox', 'menuitemradio']
	.map((role) => `[role="${role}"]`)
	.join(', ');
/** Whatever inside the menu has keys of its own: a nested menu or dialog. */
const NESTED_SCOPE =
	'[role="menu"], [role="menubar"], [role="dialog"], [role="alertdialog"], [aria-modal="true"]';

/** `el` is this menu's own: inside it, and not inside a menu or dialog nested in it. */
function ownedByMenu(el: EventTarget | null): el is HTMLElement {
	const menu = menuRef.value;
	return el instanceof HTMLElement && !!menu && el.closest(NESTED_SCOPE) === menu;
}

/** This menu's items, in order. */
function menuItems(): HTMLElement[] {
	const menu = menuRef.value;
	if (!menu) return [];
	return Array.from(menu.querySelectorAll<HTMLElement>(ITEM_SELECTOR)).filter(ownedByMenu);
}

/** The items focus lands on. */
const isEnabled = (item: HTMLElement) =>
	!item.matches(':disabled') && item.getAttribute('aria-disabled') !== 'true';

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

/** The focused element, looking into shadow roots. */
function deepActiveElement(): Element | null {
	let active = document.activeElement;
	while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
	return active;
}

/**
 * Tab when the trigger cannot take focus (disabled, or gone while the menu was
 * open): move to the first control after (Shift: before) the trigger's place
 * in the page that takes focus, wrapping inside a dialog like its own trap
 * does. A tabbable-looking control may still refuse focus (display:none, a
 * hidden input, a disabled fieldset), so each one is tried. If none takes it,
 * the press is left to the browser.
 */
function tabPastTrigger(event: KeyboardEvent) {
	const anchor = triggerRef.value;
	if (!anchor?.isConnected) return;
	const dialog = anchor.closest<HTMLElement>('[aria-modal="true"]');
	const candidates = tabbableIn(dialog ?? document.body).filter(
		(el) => !anchor.contains(el) && !menuRef.value?.contains(el)
	);
	const isAfter = (el: HTMLElement) =>
		Boolean(anchor.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
	// In the direction of the press, from the first control past the trigger;
	// a dialog then wraps around to the controls behind it.
	const ordered = event.shiftKey ? [...candidates].reverse() : candidates;
	const start = ordered.findIndex((el) => isAfter(el) !== event.shiftKey);
	const ahead = start === -1 ? [] : ordered.slice(start);
	const behind = start === -1 ? ordered : ordered.slice(0, start);
	for (const candidate of dialog ? [...ahead, ...behind] : ahead) {
		candidate.focus();
		if (deepActiveElement() === candidate) {
			event.preventDefault();
			return;
		}
	}
}

/**
 * Tab leaves the menu and closes it. The press is not prevented: from the
 * trigger, where the menu belongs in the page, the browser moves focus on to
 * the next (or previous) control as it would anyway. The menu itself is
 * teleported to the end of <body>, so from there Tab would leave the page. A
 * trigger that cannot take focus gets the move made for it.
 *
 * On the window in the capture phase, so it runs before a surrounding dialog's
 * focus trap, which then sees focus on the trigger inside the dialog.
 */
const handleTab = (event: KeyboardEvent) => {
	// A dialog or menu nested in this one handles its own Tab.
	if (event.key !== 'Tab' || !isOpen.value || !ownedByMenu(event.target)) return;
	isOpen.value = false;
	const control = triggerControl();
	control?.focus();
	if (!control || deepActiveElement() !== control) tabPastTrigger(event);
};
watch(isOpen, (open) => {
	if (open) window.addEventListener('keydown', handleTab, true);
	else window.removeEventListener('keydown', handleTab, true);
});
onUnmounted(() => window.removeEventListener('keydown', handleTab, true));

/**
 * Arrows, Home and End move between the items, for a press on one of this
 * menu's items only: a field or other widget in the menu keeps them (the caret,
 * its own options), and so does anything outside it, like a dialog opened over
 * the menu. A press something else already handled is left alone.
 */
const handleKeydown = (event: KeyboardEvent) => {
	const target = event.target;
	if (!isOpen.value || event.defaultPrevented || !ownedByMenu(target)) return;
	if (!target.matches(ITEM_SELECTOR)) return;
	const items = menuItems();
	// The nearest enabled item from `from`, stepping by `by` and wrapping.
	const step = (from: number, by: 1 | -1) => {
		for (let i = 1; i <= items.length; i++) {
			const item = items[(((from + by * i) % items.length) + items.length) % items.length];
			if (item && isEnabled(item)) return item;
		}
		return undefined;
	};
	const current = items.indexOf(target);
	let next: HTMLElement | undefined;
	if (event.key === 'ArrowDown') next = step(current, 1);
	else if (event.key === 'ArrowUp') next = step(current, -1);
	else if (event.key === 'Home') next = step(-1, 1);
	else if (event.key === 'End') next = step(items.length, -1);
	else return;
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
		document.addEventListener('keydown', handleKeydown);
		window.addEventListener('scroll', updatePosition, true);
		window.addEventListener('resize', updatePosition);

		// The first enabled item takes focus on open, opened by pointer or key.
		await nextTick();
		menuItems().find(isEnabled)?.focus();
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
