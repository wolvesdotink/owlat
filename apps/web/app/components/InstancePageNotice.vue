<script setup lang="ts">
// In the desktop app, in place of a control that posts to a server route the
// static desktop build does not have: says the work happens on the instance and
// opens `path` there in the system browser (`useInstancePage`).
import { useInstancePage } from '~/composables/useInstancePage';
import { ExternalLinkIcon } from '@coolicons/vue';

const props = defineProps<{
	/** The page on the instance that runs the control. */
	path: string;
	/** What happens on the instance, and that the browser is where to do it. */
	body: string;
}>();

const { t } = useI18n();
const { url, openFailed, openInBrowser } = useInstancePage(props.path);
</script>

<template>
	<div data-testid="instance-page-notice" class="space-y-3">
		<p class="text-sm text-text-secondary">{{ body }}</p>
		<UiButton v-if="url" variant="outline" size="sm" @click="openInBrowser">
			<ExternalLinkIcon class="w-4 h-4" aria-hidden="true" />
			{{ t('components.instancePageNotice.open') }}
			<span class="sr-only">{{ t('components.instancePageNotice.opensInBrowser') }}</span>
		</UiButton>
		<p v-else class="text-sm text-text-secondary">
			{{ t('components.instancePageNotice.noInstance') }}
		</p>
		<p v-if="openFailed && url" role="alert" class="text-sm text-error">
			{{ t('components.instancePageNotice.openFailed', { url }) }}
		</p>
	</div>
</template>
