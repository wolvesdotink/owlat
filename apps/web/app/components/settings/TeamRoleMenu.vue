<script setup lang="ts">
import type { OrganizationRole } from '~/composables/useOrganization';
import { ROLE_DEFINITIONS, roleDefinition, type RoleDefinition } from '~/utils/teamRoles';

/**
 * Inline role picker for a team member row. Shows the member's current role as a
 * button; opening it reveals every assignable role with a two-line description
 * so the meaning is surfaced at the point of choice. Fully keyboard- and
 * screen-reader-navigable (roving focus, Escape, arrow keys, Home/End).
 */
const props = withDefaults(
	defineProps<{
		role: OrganizationRole;
		disabled?: boolean;
		/** Roles the actor may assign. Defaults to the non-owner roles — ownership
		 * is transferred through its own confirmed flow, never picked here. */
		options?: readonly RoleDefinition[];
		/** Accessible name for the trigger, e.g. the member's display name. */
		memberLabel?: string;
	}>(),
	{
		disabled: false,
		options: () => ROLE_DEFINITIONS.filter((r) => r.role !== 'owner'),
		memberLabel: '',
	}
);

const emit = defineEmits<{
	change: [role: OrganizationRole];
}>();

const isOpen = ref(false);
const rootRef = ref<HTMLElement | null>(null);
const triggerRef = ref<HTMLButtonElement | null>(null);
const menuRef = ref<HTMLElement | null>(null);

const current = computed(() => roleDefinition(props.role));

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
	// Land focus on the currently-selected role so arrow keys move relative to it.
	const idx = props.options.findIndex((o) => o.role === props.role);
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
	if (rootRef.value && !rootRef.value.contains(event.target as Node)) {
		closeMenu(false);
	}
}

watch(isOpen, (open) => {
	if (open) document.addEventListener('pointerdown', handlePointerDown);
	else document.removeEventListener('pointerdown', handlePointerDown);
});

onUnmounted(() => document.removeEventListener('pointerdown', handlePointerDown));
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
				class="absolute right-0 z-50 mt-1 w-72 origin-top-right rounded-xl border border-border-subtle bg-bg-elevated py-1 shadow-lg"
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
	</div>
</template>
