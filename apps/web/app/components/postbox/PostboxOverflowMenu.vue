<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue';

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
 *
 * The panel is `v-if`-ed, so slot content is UNMOUNTED when the menu closes —
 * and a click inside a teleported modal counts as "outside". Slot content must
 * therefore not own the state of anything that has to outlive the menu (a
 * dialog opened from an item): keep that state in the parent and render the
 * dialog outside this component, as PostboxComposerFooter does for the
 * follow-up picker.
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
		align: 'right',
		direction: 'down',
		triggerClass: '',
		icon: 'lucide:more-horizontal',
	}
);

const { t } = useI18n();

// The default accessible name lives in the catalog, so it is resolved here
// rather than frozen into the prop default at compile time.
const menuLabel = computed(() => props.label ?? t('components.postbox.postboxOverflowMenu.label'));

const open = ref(false);
// The trigger is a component (<UiButton>), so this ref holds its instance, not
// an element — useClickOutside unwraps either shape.
const triggerEl = ref<ComponentPublicInstance | null>(null);
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
		<UiButton
			variant="ghost"
			ref="triggerEl"
			type="button"
			class="text-text-tertiary"
			:class="props.triggerClass"
			:title="menuLabel"
			:aria-label="menuLabel"
			aria-haspopup="menu"
			:aria-expanded="open"
			@click="toggle"
		>
			<Icon :name="props.icon" class="w-4 h-4" />
		</UiButton>
		<div
			v-if="open"
			ref="menuEl"
			role="menu"
			:aria-label="menuLabel"
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
