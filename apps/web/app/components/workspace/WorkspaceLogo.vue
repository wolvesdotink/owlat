<script setup lang="ts">
/**
 * The workspace logo an admin uploaded in Workspace → General (#810), as the
 * public pages show it: sign-in, invitations, unsubscribe and preferences.
 *
 * Dark mode is the hard part. Most logos are drawn for white paper, and a
 * dark wordmark on the dark page simply disappears. So:
 *  - with a dark variant uploaded, each theme gets its own file;
 *  - without one, the light logo sits on a light plate in dark mode, which
 *    keeps it legible without guessing at colours (an `invert` would turn a
 *    brand colour into its complement).
 *
 * Decorative by default: every page that shows it names the workspace in its
 * heading right below, and reading the name twice helps nobody.
 */
withDefaults(
	defineProps<{
		url: string;
		darkUrl?: string | null;
		alt?: string;
	}>(),
	{ darkUrl: null, alt: '' }
);
</script>

<template>
	<div class="flex items-center justify-center" data-testid="workspace-logo">
		<template v-if="darkUrl">
			<img
				:src="url"
				:alt="alt"
				class="block max-h-12 w-auto max-w-60 object-contain dark:hidden"
				data-testid="workspace-logo-light"
			/>
			<img
				:src="darkUrl"
				:alt="alt"
				class="hidden max-h-12 w-auto max-w-60 object-contain dark:block"
				data-testid="workspace-logo-dark"
			/>
		</template>
		<!-- palette-ok: the plate has to be light in BOTH themes; it is the
		     backdrop the logo was drawn for, not a surface of the app. -->
		<img
			v-else
			:src="url"
			:alt="alt"
			class="block max-h-12 w-auto max-w-60 object-contain dark:box-content dark:rounded-lg dark:bg-white dark:p-2"
			data-testid="workspace-logo-plated"
		/>
	</div>
</template>
