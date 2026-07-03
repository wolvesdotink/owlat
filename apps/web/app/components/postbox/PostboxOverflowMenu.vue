<script setup lang="ts">
/**
 * Compact "⋯" overflow menu used by the progressive-disclosure surfaces (the
 * reader's per-message action row, the composer footer). Renders a single
 * icon trigger; the demoted actions live in a keyboard-focusable dropdown so
 * nothing is hidden from keyboard or touch users — they are always reachable
 * here even when the hover-only inline affordances are not.
 *
 * The default slot receives `{ close }` so an item can dismiss the menu after
 * running its action. Items should be real <button role="menuitem"> elements
 * (tab-focusable); Escape and an outside click both close the menu.
 */
const props = withDefaults(
	defineProps<{
		/** Accessible name for the trigger (also its tooltip). */
		label?: string;
		/** Which edge the panel aligns to. */
		align?: 'left' | 'right';
		/** Whether the panel opens below (default) or above the trigger. */
		direction?: 'down' | 'up';
		/** Extra classes for the trigger button. */
		triggerClass?: string;
		/** Trigger glyph — horizontal ⋯ by default. */
		icon?: string;
	}>(),
	{
		label: 'More actions',
		align: 'right',
		direction: 'down',
		triggerClass: '',
		icon: 'lucide:more-horizontal',
	},
);

const open = ref(false);
const triggerEl = ref<HTMLElement | null>(null);
const menuEl = ref<HTMLElement | null>(null);

function close() {
	open.value = false;
}
function toggle() {
	open.value = !open.value;
}

// Close on any click outside both the trigger and the panel.
useClickOutside([triggerEl, menuEl], close);
</script>

<template>
	<div class="relative inline-flex">
		<button
			ref="triggerEl"
			type="button"
			class="btn btn-ghost text-text-tertiary"
			:class="props.triggerClass"
			:title="props.label"
			:aria-label="props.label"
			aria-haspopup="menu"
			:aria-expanded="open"
			@click="toggle"
		>
			<Icon :name="props.icon" class="w-4 h-4" />
		</button>
		<div
			v-if="open"
			ref="menuEl"
			role="menu"
			:aria-label="props.label"
			class="absolute min-w-44 bg-bg-elevated border border-border-subtle rounded shadow-lg z-20 py-1"
			:class="[
				props.align === 'right' ? 'right-0' : 'left-0',
				props.direction === 'up' ? 'bottom-full mb-1' : 'top-full mt-1',
			]"
			@keydown.esc.prevent.stop="close"
		>
			<slot :close="close" />
		</div>
	</div>
</template>
