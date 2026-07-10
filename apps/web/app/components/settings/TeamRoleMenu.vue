<script setup lang="ts">
import type { OrganizationRole } from '~/composables/useOrganization';
import { ROLE_DEFINITIONS, roleDefinition } from '~/utils/teamRoles';

/**
 * Inline role picker for a team member row. Shows the member's current role as a
 * button; opening it reveals every assignable role with a two-line description
 * so the meaning is surfaced at the point of choice. Fully keyboard- and
 * screen-reader-navigable (roving focus, Escape, arrow keys, Home/End, Tab).
 *
 * The panel is teleported to <body> and anchored to the trigger with fixed
 * positioning so it is never clipped by the members table's horizontal scroll
 * container (overflow-x forces overflow-y, which would otherwise cut it off).
 */
const props = withDefaults(
	defineProps<{
		role: OrganizationRole;
		disabled?: boolean;
		/** Accessible name for the trigger, e.g. the member's display name. */
		memberLabel?: string;
	}>(),
	{
		disabled: false,
		memberLabel: '',
	}
);

const emit = defineEmits<{
	change: [role: OrganizationRole];
}>();

// Ownership is transferred through its own confirmed flow, never picked here.
const options = ROLE_DEFINITIONS.filter((r) => r.role !== 'owner');

const PANEL_WIDTH = 288; // w-72 (18rem)
const PANEL_GAP = 4; // gap between trigger and panel

const isOpen = ref(false);
const rootRef = ref<HTMLElement | null>(null);
const triggerRef = ref<HTMLButtonElement | null>(null);
const menuRef = ref<HTMLElement | null>(null);
const panelPosition = ref({ top: 0, left: 0, bottom: 0 });
const openDirection = ref<'down' | 'up'>('down');

const current = computed(() => roleDefinition(props.role));

function updatePosition() {
	const trigger = triggerRef.value;
	if (!trigger) return;
	const rect = trigger.getBoundingClientRect();
	const panelHeight = menuRef.value?.offsetHeight ?? 260;
	const spaceBelow = window.innerHeight - rect.bottom;
	const spaceAbove = rect.top;
	// Right-align the panel to the trigger, clamped into the viewport.
	const left = Math.max(
		PANEL_GAP,
		Math.min(rect.right - PANEL_WIDTH, window.innerWidth - PANEL_WIDTH - PANEL_GAP)
	);
	if (spaceBelow < panelHeight && spaceAbove > spaceBelow) {
		openDirection.value = 'up';
		panelPosition.value = { top: 0, left, bottom: window.innerHeight - rect.top + PANEL_GAP };
	} else {
		openDirection.value = 'down';
		panelPosition.value = { top: rect.bottom + PANEL_GAP, left, bottom: 0 };
	}
}

function focusItemAt(index: number) {
	const items = menuRef.value?.querySelectorAll<HTMLElement>('[role="menuitemradio"]');
	if (!items || items.length === 0) return;
	const clamped = ((index % items.length) + items.length) % items.length;
	items[clamped]?.focus();
}

async function openMenu() {
	if (props.disabled) return;
	isOpen.value = true;
	await nextTick();
	updatePosition();
	// Land focus on the currently-selected role so arrow keys move relative to it.
	const idx = options.findIndex((o) => o.role === props.role);
	focusItemAt(idx >= 0 ? idx : 0);
}

function closeMenu(refocusTrigger = true) {
	if (!isOpen.value) return;
	isOpen.value = false;
	if (refocusTrigger) nextTick(() => triggerRef.value?.focus());
}

function toggleMenu() {
	if (isOpen.value) closeMenu();
	else void openMenu();
}

function selectRole(role: OrganizationRole) {
	closeMenu();
	if (role !== props.role) emit('change', role);
}

function onMenuKeydown(event: KeyboardEvent) {
	const items = Array.from(
		menuRef.value?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []
	);
	if (items.length === 0) return;
	const currentIndex = items.findIndex((item) => item === document.activeElement);

	switch (event.key) {
		case 'Escape':
			event.preventDefault();
			closeMenu();
			break;
		case 'Tab':
			// Let focus move on naturally, but don't leave an orphaned open menu
			// (stale aria-expanded + dangling document listeners) behind.
			closeMenu(false);
			break;
		case 'ArrowDown':
			event.preventDefault();
			focusItemAt(currentIndex + 1);
			break;
		case 'ArrowUp':
			event.preventDefault();
			focusItemAt(currentIndex - 1);
			break;
		case 'Home':
			event.preventDefault();
			focusItemAt(0);
			break;
		case 'End':
			event.preventDefault();
			focusItemAt(items.length - 1);
			break;
	}
}

function onTriggerKeydown(event: KeyboardEvent) {
	// Enter/Space fall through to the button's native click (which toggles);
	// only the arrow keys need to open-and-focus the list explicitly.
	if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
		event.preventDefault();
		void openMenu();
	}
}

function handlePointerDown(event: PointerEvent) {
	const target = event.target as Node;
	// The panel is teleported outside rootRef, so an in-panel click must be
	// treated as inside (otherwise selecting a role would close before the click).
	const insideRoot = rootRef.value?.contains(target) ?? false;
	const insideMenu = menuRef.value?.contains(target) ?? false;
	if (!insideRoot && !insideMenu) {
		closeMenu(false);
	}
}

function addListeners() {
	document.addEventListener('pointerdown', handlePointerDown);
	window.addEventListener('scroll', updatePosition, true);
	window.addEventListener('resize', updatePosition);
}

function removeListeners() {
	document.removeEventListener('pointerdown', handlePointerDown);
	window.removeEventListener('scroll', updatePosition, true);
	window.removeEventListener('resize', updatePosition);
}

watch(isOpen, (open) => {
	if (open) addListeners();
	else removeListeners();
});

onUnmounted(removeListeners);
</script>

<template>
	<div ref="rootRef" class="relative inline-block text-left">
		<button
			ref="triggerRef"
			type="button"
			class="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border border-border-subtle text-xs font-medium text-text-primary transition-colors hover:border-border-default focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand disabled:opacity-60 disabled:cursor-not-allowed"
			:disabled="disabled"
			aria-haspopup="menu"
			:aria-expanded="isOpen"
			:aria-label="
				memberLabel ? `Change role for ${memberLabel} (currently ${current.label})` : 'Change role'
			"
			@click="toggleMenu"
			@keydown="onTriggerKeydown"
		>
			<Icon :name="current.icon" class="w-3.5 h-3.5" />
			<span>{{ current.label }}</span>
			<Icon v-if="!disabled" name="lucide:chevron-down" class="w-3 h-3 text-text-tertiary" />
		</button>

		<Teleport to="body">
			<Transition
				enter-active-class="duration-(--motion-fast) ease-spring"
				enter-from-class="opacity-0 scale-95"
				enter-to-class="opacity-100 scale-100"
				leave-active-class="duration-(--motion-fast) ease-exit"
				leave-from-class="opacity-100 scale-100"
				leave-to-class="opacity-0 scale-95"
			>
				<div
					v-if="isOpen"
					ref="menuRef"
					role="menu"
					aria-label="Assign role"
					class="fixed z-50 w-72 rounded-xl border border-border-subtle bg-bg-elevated py-1 shadow-lg"
					:style="{
						top: openDirection === 'up' ? 'auto' : `${panelPosition.top}px`,
						bottom: openDirection === 'up' ? `${panelPosition.bottom}px` : 'auto',
						left: `${panelPosition.left}px`,
						transformOrigin: openDirection === 'up' ? 'bottom right' : 'top right',
					}"
					@keydown="onMenuKeydown"
				>
					<button
						v-for="option in options"
						:key="option.role"
						type="button"
						role="menuitemradio"
						:aria-checked="option.role === role"
						tabindex="-1"
						class="flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-bg-surface focus-visible:bg-bg-surface focus-visible:outline-none"
						@click="selectRole(option.role)"
					>
						<Icon :name="option.icon" class="mt-0.5 w-4 h-4 shrink-0 text-text-secondary" />
						<span class="min-w-0 flex-1">
							<span class="flex items-center gap-1.5">
								<span class="text-sm font-medium text-text-primary">{{ option.label }}</span>
								<Icon
									v-if="option.role === role"
									name="lucide:check"
									class="w-3.5 h-3.5 text-brand"
									aria-hidden="true"
								/>
							</span>
							<span class="mt-0.5 block text-xs text-text-secondary">{{ option.summary }}</span>
							<span class="mt-0.5 block text-xs text-text-tertiary">{{ option.detail }}</span>
						</span>
					</button>
				</div>
			</Transition>
		</Teleport>
	</div>
</template>
