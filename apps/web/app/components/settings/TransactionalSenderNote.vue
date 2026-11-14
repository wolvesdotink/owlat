<script setup lang="ts">
/**
 * Beside the default sender on General settings: which address transactional
 * mail (password resets, receipts) goes out from, and the way to the place it
 * is set, the Transactional page. Rendered in every state, because the
 * settings search deep-links to it.
 */
import { api } from '@owlat/api';
import { TRANSACTIONAL_SENDER_HREF, formatFromAddress } from '~/utils/transactionalSender';
import { ArrowRightIcon } from '@coolicons/vue';

const { t } = useI18n();
const { isEnabled } = useFeatureFlag();
const P = 'components.settings.transactionalSenderNote';

const { data: settings } = useOrganizationQuery(api.workspaces.settings.get);

const line = computed(() => {
	const email = settings.value?.transactionalFromEmail;
	if (!email) return t(`${P}.usesDefault`);
	return t(`${P}.own`, {
		from: formatFromAddress(settings.value?.transactionalFromName ?? '', email),
	});
});
</script>

<template>
	<div
		class="rounded-lg bg-bg-surface px-4 py-3 text-xs text-text-secondary"
		data-testid="transactional-sender-note"
	>
		<template v-if="isEnabled('transactional')">
			<p>{{ line }}</p>
			<NuxtLink
				:to="TRANSACTIONAL_SENDER_HREF"
				class="mt-1 inline-flex items-center gap-1 font-medium text-brand hover:underline"
			>
				{{ settings?.transactionalFromEmail ? t(`${P}.changeAction`) : t(`${P}.action`) }}
				<ArrowRightIcon class="w-3.5 h-3.5" aria-hidden="true" />
			</NuxtLink>
		</template>
		<p v-else>{{ t(`${P}.off`) }}</p>
	</div>
</template>
