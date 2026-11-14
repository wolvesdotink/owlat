<script setup lang="ts">
// A readiness verdict's or gate's fix link. In the desktop app a fix that
// changes the transport opens the instance's transport page in the system
// browser, because the editor cannot run there (`useInstanceTransportPage`);
// every other fix stays an in-app link.
import type { LocalizedText } from '~/utils/localizedText';
import { useLocalized } from '~/composables/useLocalized';
import {
	isTransportChangeAction,
	useInstanceTransportPage,
} from '~/composables/useInstanceTransportPage';
import { ArrowRightIcon, ExternalLinkIcon } from '@coolicons/vue';

const props = defineProps<{ href: string; label: LocalizedText }>();

const { t } = useI18n();
const localized = useLocalized();
const { isDesktop, url, openFailed, openInBrowser } = useInstanceTransportPage();

const opensInBrowser = computed(
	() => isDesktop && url !== null && isTransportChangeAction(props.href, props.label)
);
const linkClass =
	'inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline shrink-0 group';
</script>

<template>
	<span v-if="opensInBrowser" class="inline-flex flex-col items-start shrink-0">
		<button type="button" :class="linkClass" @click="openInBrowser">
			{{ localized(label) }}
			<span class="sr-only">{{ t('components.delivery.instanceTransport.opensInBrowser') }}</span>
			<ExternalLinkIcon class="w-3.5 h-3.5" aria-hidden="true" />
		</button>
		<span v-if="openFailed" role="alert" class="text-xs text-error">
			{{ t('components.delivery.instanceTransport.openFailed', { url }) }}
		</span>
	</span>
	<NuxtLink v-else :to="href" :class="linkClass">
		{{ localized(label) }}
		<ArrowRightIcon
			class="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform duration-(--motion-fast)"
		/>
	</NuxtLink>
</template>
