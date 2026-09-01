<script setup lang="ts">
/**
 * One navigation row in the Postbox folder rail.
 *
 * The rail had seven near-identical `<NuxtLink>` blocks — each repeating the
 * expanded/collapsed class pair, the collapsed `title` + `aria-label`, and the
 * inline-count vs corner-badge switch. They are one row type, so they are one
 * component: adding a destination to the rail (or to its "More" group) is now a
 * line, not a copied twenty.
 *
 * Collapsed, the rail is a ~48px icon strip: the label survives only as `title`
 * + `aria-label`, or the strip is unusable with a screen reader, and a count
 * moves from an inline number to a corner badge for the same reason.
 */
withDefaults(
	defineProps<{
		to: string;
		/** Lucide icon name, e.g. `lucide:paperclip`. */
		icon: string;
		label: string;
		/** Rail is the narrow icon strip. */
		collapsed?: boolean;
		/** Inline number when expanded, corner badge when collapsed. `0` hides it. */
		count?: number;
		/** Marks the row current (rail state, not route matching). */
		active?: boolean;
		/**
		 * Accessible name to use instead of `label` while a count is showing —
		 * "Reply Queue, 2" reads better than the bare name, and the phrasing
		 * belongs to the caller's message catalog, not to a generic row.
		 */
		countLabel?: string;
		/** Lighter weight, for secondary destinations. */
		muted?: boolean;
	}>(),
	{ collapsed: false, count: 0, active: false, countLabel: undefined, muted: false }
);
</script>

<template>
	<NuxtLink
		:to="to"
		class="rounded text-sm"
		:class="[
			collapsed
				? 'relative flex items-center justify-center w-9 h-9'
				: 'flex items-center gap-2 px-2.5 py-1.5',
			muted ? 'text-text-tertiary hover:text-text-secondary' : '',
			active ? 'bg-bg-surface text-brand' : 'hover:bg-bg-surface',
		]"
		:title="collapsed ? label : undefined"
		:aria-label="collapsed ? (count > 0 ? (countLabel ?? label) : label) : undefined"
		:aria-current="active ? 'page' : undefined"
	>
		<Icon :name="icon" class="w-4 h-4 flex-shrink-0" />
		<template v-if="!collapsed">
			<span class="flex-1 truncate">{{ label }}</span>
			<span v-if="count > 0" class="text-xs font-medium text-text-secondary flex-shrink-0">{{
				count
			}}</span>
		</template>
		<span
			v-else-if="count > 0"
			class="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-text-primary text-text-inverse text-2xs leading-4 font-medium text-center"
			>{{ count > 99 ? '99+' : count }}</span
		>
	</NuxtLink>
</template>
