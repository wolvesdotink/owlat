<script setup lang="ts">
// In the desktop app, in place of the controls that change the transport: the
// transport is set up on the instance itself, and this opens the instance's
// transport page in the system browser (`useInstanceTransportPage`). `compact`
// is the one-paragraph form the hub's transport card uses.
import { useInstanceTransportPage } from '~/composables/useInstanceTransportPage';
import { ExternalLinkIcon, ServerIcon } from '@coolicons/vue';

withDefaults(defineProps<{ compact?: boolean }>(), { compact: false });

const { t } = useI18n();
const { url, openFailed, openInBrowser } = useInstanceTransportPage();
</script>

<template>
	<section
		data-testid="instance-transport-notice"
		:class="compact ? 'space-y-3' : 'card p-6 space-y-3'"
	>
		<div v-if="!compact" class="flex items-center gap-3">
			<ServerIcon class="w-5 h-5 text-text-tertiary shrink-0" aria-hidden="true" />
			<h2 class="text-lg font-semibold text-text-primary">
				{{ t('components.delivery.instanceTransport.title') }}
			</h2>
		</div>
		<p class="text-sm text-text-secondary">
			{{ t('components.delivery.instanceTransport.body') }}
		</p>
		<UiButton v-if="url" @click="openInBrowser">
			<ExternalLinkIcon class="w-4 h-4" aria-hidden="true" />
			{{ t('components.delivery.instanceTransport.open') }}
			<span class="sr-only">{{ t('components.delivery.instanceTransport.opensInBrowser') }}</span>
		</UiButton>
		<p v-else class="text-sm text-text-secondary">
			{{ t('components.delivery.instanceTransport.noInstance') }}
		</p>
		<p v-if="openFailed && url" role="alert" class="text-sm text-error">
			{{ t('components.delivery.instanceTransport.openFailed', { url }) }}
		</p>
	</section>
</template>
