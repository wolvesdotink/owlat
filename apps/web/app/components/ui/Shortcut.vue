<script setup lang="ts">
import { computed } from 'vue';
import { useShortcutLabels } from '~/composables/useShortcutLabels';

/**
 * A shortcut hint chip: `<UiShortcut id="global.commandPalette" />` renders
 * `⌘K` on a Mac and `Ctrl+K` everywhere else, follows the user's preset and
 * remaps, and renders NOTHING while no key fires the id (unbound, or taken
 * over by the surface on screen) rather than advertising a dead key.
 *
 * `chord` is for the rare fixed chord the registry does not own (a click
 * modifier); it still gets the platform right. Styling is the caller's: the
 * classes land on the `<kbd>`.
 */
const props = defineProps<{
	/** A shortcut catalog id (`utils/shortcutCatalog.ts`). */
	id?: string;
	/** A fixed chord in registry notation (`mod+Enter`), when there is no id. */
	chord?: string;
}>();

const { labelFor, chordLabel } = useShortcutLabels();

const label = computed(() => {
	if (props.id) return labelFor(props.id);
	return props.chord ? chordLabel(props.chord) || null : null;
});
</script>

<template>
	<kbd v-if="label">{{ label }}</kbd>
</template>
