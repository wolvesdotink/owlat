<script setup lang="ts">
/**
 * Email links (Preferences → This device): ask this browser to open `mailto:`
 * links in Owlat's composer instead of the computer's mail app.
 *
 * Browser only. The desktop app is a mail handler of the operating system and
 * explains that on its own card; a webview has no business registering one.
 * Only the browser can undo the registration, so the card always says where.
 */
import {
	mailtoHandlerSupport,
	requestMailtoHandler,
	type MailtoHandlerSupport,
} from '~/utils/mailtoHandler';
import { UndoIcon } from '@coolicons/vue';

const { t } = useI18n();

const KEY = 'components.preferences.mailtoHandler';

// `navigator` exists only once mounted; until then the button waits.
const support = ref<MailtoHandlerSupport | null>(null);
const result = ref<'requested' | 'failed' | null>(null);

onMounted(() => {
	support.value = mailtoHandlerSupport({
		isSecureContext: window.isSecureContext,
		registerProtocolHandler: navigator.registerProtocolHandler,
	});
});

function onRequest() {
	result.value = requestMailtoHandler(navigator, window.location.origin) ? 'requested' : 'failed';
}

const statusLine = computed(() => {
	if (support.value === 'unsupported') return t(`${KEY}.status.unsupported`);
	if (support.value === 'insecure') return t(`${KEY}.status.insecure`);
	if (result.value) return t(`${KEY}.status.${result.value}`);
	return t(`${KEY}.status.idle`);
});
</script>

<template>
	<section
		id="mailto-handler"
		class="card !p-0 mb-6 scroll-mt-6 overflow-hidden"
		data-testid="mailto-handler-settings"
	>
		<header class="px-5 py-3 border-b border-border-subtle">
			<h2 class="font-semibold">{{ t(`${KEY}.heading`) }}</h2>
			<I18nT
				:keypath="`${KEY}.intro`"
				tag="p"
				class="text-xs text-text-tertiary mt-0.5"
				scope="global"
			>
				<template #mailto><code>mailto:</code></template>
			</I18nT>
		</header>

		<div class="px-5 py-4 flex items-center justify-between gap-4">
			<div class="min-w-0">
				<p class="font-medium text-sm">{{ t(`${KEY}.thisBrowser`) }}</p>
				<p
					class="text-xs mt-0.5"
					:class="result === 'failed' ? 'text-error' : 'text-text-tertiary'"
					:role="result ? 'status' : undefined"
					data-testid="mailto-handler-status"
				>
					{{ statusLine }}
				</p>
			</div>
			<UiButton
				v-if="support !== 'unsupported' && support !== 'insecure'"
				size="sm"
				class="shrink-0"
				:variant="result === 'requested' ? 'secondary' : 'primary'"
				:disabled="support === null"
				data-testid="mailto-handler-request"
				@click="onRequest"
			>
				{{ t(`${KEY}.request`) }}
			</UiButton>
		</div>

		<div class="px-5 py-3 border-t border-border-subtle bg-bg-surface flex gap-3">
			<UndoIcon class="w-4 h-4 mt-0.5 shrink-0 text-text-secondary" />
			<p class="text-xs text-text-secondary" data-testid="mailto-handler-undo">
				{{ t(`${KEY}.undo`) }}
			</p>
		</div>
	</section>
</template>
