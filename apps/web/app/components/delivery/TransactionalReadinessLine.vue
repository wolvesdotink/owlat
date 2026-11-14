<script setup lang="ts">
/**
 * The transactional verdict where transactional work happens: one line with
 * the same chip and sentence the Delivery hub shows, so a template or an API
 * snippet is never handed over while the first send would be refused.
 *
 * The hub and every fix link are admin pages, so a member sees the verdict and
 * is told who can fix it instead of being sent to a page that turns them away.
 * Under the verdict, the sender it is about: the address an operator sets is
 * read where they judge whether their app can send.
 */
import { useDeliveryReadiness } from '~/composables/useDeliveryReadiness';
import { ArrowRightIcon } from '@coolicons/vue';

const HUB_HREF = '/dashboard/admin/delivery';

const { t } = useI18n();
const { isAdmin } = usePermissions();
const { readiness, isLoading, error, retry } = useDeliveryReadiness({ scope: 'transactional' });

const verdict = computed(
	() => readiness.value?.streams.find((stream) => stream.stream === 'transactional') ?? null
);
const levelWord = computed(() =>
	verdict.value ? t(`shared.deliveryReadiness.streams.level.${verdict.value.level}`) : ''
);
</script>

<template>
	<div
		v-if="isLoading"
		class="h-12 rounded-lg bg-bg-surface animate-pulse motion-reduce:animate-none"
		role="status"
		:aria-label="t('components.delivery.readinessPanel.compact.loading')"
		data-testid="transactional-readiness-loading"
	/>
	<div
		v-else-if="error"
		class="flex flex-wrap items-center gap-3 rounded-lg bg-bg-surface px-4 py-3 text-sm text-text-secondary"
		data-testid="transactional-readiness-error"
	>
		<p class="flex-1 min-w-0">{{ t('components.delivery.readinessPanel.compact.error') }}</p>
		<UiButton size="sm" variant="secondary" @click="retry">
			{{ t('components.delivery.readinessPanel.compact.retry') }}
		</UiButton>
	</div>
	<!-- Transactional sending switched off: no verdict to give. -->
	<div
		v-else-if="verdict"
		class="rounded-lg bg-bg-surface px-4 py-3 space-y-1.5"
		data-testid="transactional-readiness"
	>
		<!-- The verdict is announced when it changes, e.g. once a domain verifies. -->
		<p class="sr-only" role="status">
			{{ t('components.delivery.readinessPanel.compact.title', { level: levelWord }) }}
		</p>
		<DeliveryStreamVerdict
			:verdict="verdict"
			:heading="t('components.delivery.readinessPanel.compact.heading')"
			:show-action="isAdmin"
		/>
		<!-- The address the verdict is about, and where an admin changes it. -->
		<LazyTransactionalSenderRow />
		<p v-if="!isAdmin && verdict.level !== 'ready'" class="text-xs text-text-tertiary">
			{{ t('components.delivery.readinessPanel.compact.askAdmin') }}
		</p>
		<NuxtLink
			v-if="isAdmin"
			:to="HUB_HREF"
			class="inline-flex items-center gap-1 text-xs font-medium text-text-secondary hover:text-text-primary group"
		>
			{{ t('components.delivery.readinessPanel.compact.hub') }}
			<ArrowRightIcon
				class="w-3 h-3 group-hover:translate-x-0.5 transition-transform duration-(--motion-fast)"
			/>
		</NuxtLink>
	</div>
</template>
