<script setup lang="ts">
/**
 * The app's pane boundary: UiErrorBoundary with the app's defaults. A pane that
 * fails to render (the reader, a message body, the list, a composer, the page)
 * shows what broke and a Retry while the shell around it keeps working.
 *
 * - Resets on navigation: the current route's full path is always a reset key,
 *   so following any link away from a failed pane recovers it. `resetKeys` add
 *   the pane's own identity (message, draft) for selections that do not change
 *   the route.
 * - Contains render failures only (see utils/renderPhaseError.ts); a failing
 *   event handler still reaches the app's error handler and its toast.
 * - Reports what it contained to diagnostics, with no toast.
 *
 * The route and the reporter are injected rather than read through Nuxt
 * composables, so a component test that mounts a host of this boundary needs
 * neither a router nor the error plugin.
 */
import { computed, inject } from 'vue';
import { routeLocationKey } from 'vue-router';
import type { ClientErrorReporter, ClientErrorReporterKey } from '~/lib/clientErrorReporter';
import { isContainedRenderError } from '~/utils/renderPhaseError';

type ErrorBoundarySurface = 'page' | 'reader' | 'messageBody' | 'list' | 'composer';

const props = defineProps<{
	/** What failed, for the fallback copy and the diagnostics source. */
	surface: ErrorBoundarySurface;
	/** Reset keys on top of the route. */
	resetKeys?: readonly unknown[];
}>();

const { t } = useI18n();
const route = inject(routeLocationKey, null);
const reportError = inject<ClientErrorReporter | null>(
	'owlat:client-error-reporter' satisfies ClientErrorReporterKey,
	null
);

// One literal key per surface so the catalog keys stay greppable.
const MESSAGE_KEYS: Record<ErrorBoundarySurface, string> = {
	page: 'shell.paneError.page',
	reader: 'shell.paneError.reader',
	messageBody: 'shell.paneError.messageBody',
	list: 'shell.paneError.list',
	composer: 'shell.paneError.composer',
};

const keys = computed(() => [route?.fullPath, ...(props.resetKeys ?? [])]);

function onCaptured(error: unknown, info: string) {
	reportError?.(error, `boundary:${props.surface}:${info}`);
}
</script>

<template>
	<UiErrorBoundary
		:name="surface"
		:reset-keys="keys"
		:capture="isContainedRenderError"
		:fallback-message="t(MESSAGE_KEYS[surface])"
		:fallback-detail="t('shell.paneError.detail')"
		@captured="onCaptured"
	>
		<slot />
	</UiErrorBoundary>
</template>
