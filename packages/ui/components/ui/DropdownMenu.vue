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

/**
 * What the arrows move between: the menu's items, and any plain button or link
 * a caller put in the menu (a stepper, say). With Tab closing the menu, a
 * control the arrows skipped could not be reached from the keyboard at all.
 */
const ITEM_KINDS = [
	...['menuitem', 'menuitemcheckbox', 'menuitemradio'].map((role) => `[role="${role}"]`),
	'button:not([role])',
	'a[href]:not([role])',
];
const ITEM_SELECTOR = ITEM_KINDS.join(', ');
/** The enabled ones, which focus lands on. */
const MENU_ITEM_SELECTOR = ITEM_KINDS.map(
	(kind) => `${kind}:not([disabled]):not([aria-disabled="true"])`
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
 * Tab when the trigger cannot take focus (disabled, or gone while the menu was
 * open): move to the control after (Shift: before) the trigger's place in the
 * page, or in its dialog, which wraps like the dialog's own trap does.
 */
function tabPastTrigger(event: KeyboardEvent) {
	const anchor = triggerRef.value;
	if (!anchor?.isConnected) return;
	const root = anchor.closest<HTMLElement>('[aria-modal="true"]') ?? document.body;
	const candidates = tabbableIn(root).filter(
		(el) => !anchor.contains(el) && !menuRef.value?.contains(el)
	);
	const after = (el: HTMLElement) =>
		Boolean(anchor.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
	let next = event.shiftKey ? candidates.findLast((el) => !after(el)) : candidates.find(after);
	if (!next && root !== document.body) next = event.shiftKey ? candidates.at(-1) : candidates[0];
	event.preventDefault();
	if (next) next.focus();
	else (document.activeElement as HTMLElement | null)?.blur();
}

/** A press on something inside the menu, the only presses the menu acts on. */
function inMenu(event: KeyboardEvent): HTMLElement | null {
	const target = event.target as HTMLElement | null;
	return isOpen.value && target && menuRef.value?.contains(target) ? target : null;
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
	if (event.key !== 'Tab' || !inMenu(event)) return;
	isOpen.value = false;
	const control = triggerControl();
	control?.focus();
	if (!control || document.activeElement !== control) tabPastTrigger(event);
};
watch(isOpen, (open) => {
	if (open) window.addEventListener('keydown', handleTab, true);
	else window.removeEventListener('keydown', handleTab, true);
});
onUnmounted(() => window.removeEventListener('keydown', handleTab, true));

/**
 * Arrows, Home and End move between the items, for a press on an item only: a
 * field or other widget in the menu keeps them (the caret, its own options),
 * and so does anything outside it, like a dialog opened over the menu.
 */
const handleKeydown = (event: KeyboardEvent) => {
	const target = inMenu(event);
	const menu = menuRef.value;
	if (!menu || !target?.matches(ITEM_SELECTOR)) return;
	const items = Array.from(menu.querySelectorAll<HTMLElement>(ITEM_SELECTOR));
	// The nearest enabled item from `from`, stepping by `by` and wrapping.
	const step = (from: number, by: 1 | -1) => {
		for (let i = 1; i <= items.length; i++) {
			const item = items[(((from + by * i) % items.length) + items.length) % items.length];
			if (item?.matches(MENU_ITEM_SELECTOR)) return item;
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
