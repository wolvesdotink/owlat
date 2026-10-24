<script setup lang="ts">
/**
 * `<NuxtPage>` with the page's error boundary inside it. Use it wherever a
 * page outlet renders under the dashboard shell.
 *
 * The boundary has to sit inside NuxtPage's transition and Suspense, around
 * the page component itself. Around the whole outlet it would swap out a
 * Suspense that is still resolving a navigation, and Vue then fails to move
 * the resolved page into place (an uncaught `insertBefore` DOM error). Inside,
 * each page gets its own boundary, keyed with the page by NuxtPage.
 */
import { inject, type Component } from 'vue';
import type { ShellPageBoundaryKey } from '~/lib/pageBoundary';

defineOptions({ inheritAttrs: false });

// Under the dashboard shell only; see ShellPageBoundaryKey for why it is injected.
const boundary = inject<Component | null>(
	'owlat:shell-page-boundary' satisfies ShellPageBoundaryKey,
	null
);
</script>

<template>
	<NuxtPage v-bind="$attrs">
		<template #default="{ Component }">
			<component :is="boundary" v-if="boundary" surface="page">
				<component :is="Component" />
			</component>
			<component :is="Component" v-else />
		</template>
	</NuxtPage>
</template>
