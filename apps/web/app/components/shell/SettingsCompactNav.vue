<script setup lang="ts">
/**
 * The Settings navigation below `lg`: a scrollable row of pills, one per page,
 * plus a trailing link to the other half of Settings (My settings ↔
 * Workspace). Both settings layouts render this one component, so the two
 * halves look alike on a phone and each has the same way across.
 *
 * The rail is in the DOM at the same time (the swap is a media query), so the
 * caller passes a DISTINGUISHABLE landmark name.
 */
defineProps<{
	label: string;
	entries: readonly { path: string; title: string }[];
	currentPath: string;
	/** The other half of Settings, when the viewer can reach it. */
	across?: { path: string; title: string } | null;
}>();

const pill =
	'shrink-0 rounded-full border px-3 py-1 text-xs transition-colors duration-(--motion-fast)';
</script>

<template>
	<nav class="lg:hidden flex gap-1.5 overflow-x-auto pb-1" :aria-label="label">
		<NuxtLink
			v-for="entry in entries"
			:key="entry.path"
			:to="entry.path"
			:class="[
				pill,
				currentPath === entry.path
					? 'border-brand bg-brand-subtle font-medium text-text-primary'
					: 'border-border-default text-text-secondary hover:text-text-primary',
			]"
			:aria-current="currentPath === entry.path ? 'page' : undefined"
		>
			{{ entry.title }}
		</NuxtLink>
		<NuxtLink
			v-if="across"
			:to="across.path"
			:class="[pill, 'border-border-default text-text-secondary hover:text-text-primary']"
			data-testid="settings-compact-across"
		>
			{{ across.title }}
		</NuxtLink>
	</nav>
</template>
