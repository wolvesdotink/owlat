<script setup lang="ts">
/**
 * The one page frame every settings page sits in, My settings and Workspace
 * alike: the same padding, a reading width of 880 px, and the same title block.
 *
 * The frame is centred in the content area and capped at `max-w-page`; the
 * reading column sits left-aligned inside it. On a wide display a left-pinned
 * 880 px column left two thirds of the screen empty, and centring the reading
 * column itself would make titles jump sideways between reading and wide pages.
 *
 * The pages grew four different frames of their own (full width, ~860 px left,
 * ~900 px centred, ~700 px centred with a "← Settings" link), so moving between
 * neighbours made the content jump sideways. The shell is now the only frame:
 * a settings page's root carries no width, centring or padding of its own (a
 * test pins that), and the shell sets its `<h1>` in one style. Tables that need
 * room (domains, cells) opt into the full width through the registry's `wide`.
 */
defineProps<{
	/** Let the page use the whole content area instead of the reading width. */
	wide?: boolean;
}>();
</script>

<template>
	<div
		class="settings-page-shell mx-auto w-full max-w-page px-4 py-6 sm:px-6 lg:px-8"
		:data-width="wide ? 'wide' : 'reading'"
	>
		<div :class="wide ? undefined : 'max-w-[880px]'">
			<slot name="above" />
			<div class="settings-page-body">
				<slot />
			</div>
		</div>
	</div>
</template>

<style scoped>
/* One title block. */
.settings-page-body :deep(h1) {
	font-size: 1.5rem;
	line-height: 2rem;
	font-weight: 500;
	letter-spacing: -0.02em;
}
</style>
