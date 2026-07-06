<script setup lang="ts">
/**
 * The shared shell every agent task card sits in — one card anatomy for BOTH
 * queues (Postbox Reply Queue and the Review Queue stay separate surfaces; this
 * makes equivalent states render identically).
 *
 * Fluid Functionalism: surface-2 + the shadow ladder (the `surface-2` utility),
 * a 2px brand left spine marking "the agent is asking you something", and a
 * focus ring on --color-brand. Purely presentational; attrs (id, role,
 * aria-*, tabindex, keydown) fall through to the root so consumers can wire the
 * card into their existing listbox keyboard handling.
 *
 * Explicitly imported by consumers (never relied on via the path-prefixed
 * auto-import name).
 */
withDefaults(
	defineProps<{
		/** Rendered root element — e.g. 'li' inside a listbox. */
		as?: string;
		/** The brand left spine. On by default; off for plain informational cards. */
		spine?: boolean;
		/** Tighter padding for nested cards (e.g. a slot inside a queue row). */
		dense?: boolean;
		/** Listbox focus ring (driven by the parent's focusedIndex). */
		focused?: boolean;
	}>(),
	{ as: 'div', spine: true, dense: false, focused: false }
);
</script>

<template>
	<component
		:is="as"
		class="relative surface-2 rounded-lg outline-none focus-visible:ring-1 focus-visible:ring-brand/40 transition-shadow duration-(--motion-fast)"
		:class="[
			spine ? 'border-l-2 border-l-brand/60' : '',
			dense ? 'p-3' : 'p-4',
			focused ? 'ring-2 ring-brand/60' : '',
		]"
	>
		<slot />
	</component>
</template>
