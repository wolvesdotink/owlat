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
import { inject } from 'vue';
import { shellPageBoundaryKey } from '~/lib/pageBoundary';

defineOptions({ inheritAttrs: false });

const inShell = inject(shellPageBoundaryKey, false);
</script>

<template>
	<NuxtPage v-bind="$attrs">
		<template #default="{ Component }">
			<AppErrorBoundary v-if="inShell" surface="page">
				<component :is="Component" />
			</AppErrorBoundary>
			<component :is="Component" v-else />
		</template>
	</NuxtPage>
</template>
