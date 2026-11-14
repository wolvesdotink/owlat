<script setup lang="ts">
/**
 * "Sends from …" under the transactional verdict: the address a template that
 * names no sender goes out from, which setting it comes from, and, for an
 * admin, the way to change it. The change opens the sender dialog through the
 * Transactional page's `?sender=edit`, the same address the Delivery hub and
 * General settings link to.
 */
import { api } from '@owlat/api';
import { TRANSACTIONAL_SENDER_HREF, formatFromAddress } from '~/utils/transactionalSender';

const { t } = useI18n();
const P = 'components.transactional.senderRow';

const { data, isLoading, error, refetch } = useOrganizationQuery(api.transactional.sender.get);

const resolved = computed(() => data.value?.resolved ?? null);
const from = computed(() =>
	resolved.value?.address
		? formatFromAddress(resolved.value.name ?? '', resolved.value.address)
		: ''
);
</script>

<template>
	<p
		v-if="isLoading && !data"
		class="text-xs text-text-tertiary"
		data-testid="transactional-sender-loading"
	>
		{{ t(`${P}.loading`) }}
	</p>
	<p
		v-else-if="error"
		class="text-xs text-text-secondary flex flex-wrap items-center gap-x-2"
		data-testid="transactional-sender-error"
	>
		{{ t(`${P}.error`) }}
		<button type="button" class="underline hover:text-text-primary" @click="refetch()">
			{{ t('common.tryAgain') }}
		</button>
	</p>
	<div
		v-else-if="data"
		class="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs"
		data-testid="transactional-sender"
	>
		<template v-if="resolved?.address">
			<span class="text-text-tertiary">{{ t(`${P}.sendsFrom`) }}</span>
			<span class="font-medium text-text-primary break-words">{{ from }}</span>
			<span class="text-text-tertiary">
				<span aria-hidden="true">·</span>
				{{ resolved.source === 'transactional' ? t(`${P}.ownSender`) : t(`${P}.defaultSender`) }}
			</span>
		</template>
		<span v-else class="text-text-secondary">{{ t(`${P}.none`) }}</span>
		<NuxtLink
			v-if="data.canManageInstance"
			:to="TRANSACTIONAL_SENDER_HREF"
			class="font-medium text-brand hover:underline"
			data-testid="transactional-sender-change"
		>
			{{ resolved?.address ? t(`${P}.change`) : t(`${P}.set`) }}
		</NuxtLink>
	</div>
</template>
