<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import type { DeliverabilityLoopbackResult } from '~/utils/deliverabilityCenter';

const props = defineProps<{
	domains: Array<{
		id: Id<'domains'>;
		domain: string;
		eligible: boolean;
		blockedReason?: string;
		latest?: DeliverabilityLoopbackResult;
	}>;
	isStarting?: boolean;
}>();

const emit = defineEmits<{
	start: [domainId: Id<'domains'>];
}>();

const { t } = useI18n();

const selectedDomainId = ref<Id<'domains'> | ''>('');
const selectedDomain = computed(() =>
	props.domains.find((domain) => domain.id === selectedDomainId.value)
);
const latest = computed(() => selectedDomain.value?.latest);
watch(
	() => props.domains,
	(domains) => {
		if (!domains.some((domain) => domain.id === selectedDomainId.value)) {
			selectedDomainId.value = domains[0]?.id ?? '';
		}
	},
	{ immediate: true }
);

const resultItems = computed(() => {
	const result = latest.value;
	if (!result) return [];
	return [
		{
			key: 'spf',
			label: t('components.delivery.deliverabilityLoopbackCard.mechanisms.spf'),
			value: result.spf,
		},
		{
			key: 'dkim',
			label: t('components.delivery.deliverabilityLoopbackCard.mechanisms.dkim'),
			value: result.dkim,
			detail: result.dkimSelector,
		},
		{
			key: 'dmarc',
			label: t('components.delivery.deliverabilityLoopbackCard.mechanisms.dmarc'),
			value: result.dmarc,
		},
	].filter((item) => item.value);
});
const isInFlight = computed(
	() => latest.value?.status === 'sending' || latest.value?.status === 'awaiting_inbound'
);
const latestStatusLabel = computed(() => {
	switch (latest.value?.status) {
		case 'sending':
			return t('components.delivery.deliverabilityLoopbackCard.status.sending');
		case 'awaiting_inbound':
			return t('components.delivery.deliverabilityLoopbackCard.status.awaitingInbound');
		case 'passed':
			return t('components.delivery.deliverabilityLoopbackCard.status.passed');
		case 'failed':
			return t('components.delivery.deliverabilityLoopbackCard.status.failed');
		case 'timed_out':
			return t('components.delivery.deliverabilityLoopbackCard.status.timedOut');
		default:
			return '';
	}
});

const resultIcon = {
	pass: 'lucide:check-circle-2',
	fail: 'lucide:x-circle',
	unknown: 'lucide:circle-dashed',
} as const;
const resultClass = {
	pass: 'text-success',
	fail: 'text-error',
	unknown: 'text-text-tertiary',
} as const;

function start() {
	if (selectedDomainId.value) emit('start', selectedDomainId.value);
}
</script>

<template>
	<UiCard padding="none" overflow="hidden">
		<template #header>
			<div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
				<div class="flex items-start gap-3">
					<UiIconBox icon="lucide:send-horizontal" size="sm" variant="surface" rounded="lg" />
					<div>
						<h2 class="text-lg font-semibold text-text-primary">
							{{ t('components.delivery.deliverabilityLoopbackCard.title') }}
						</h2>
						<p class="text-sm text-text-secondary">
							{{ t('components.delivery.deliverabilityLoopbackCard.subtitle') }}
						</p>
					</div>
				</div>
				<span
					v-if="latest"
					class="inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium"
					:class="{
						'border-success/30 bg-success/10 text-success': latest.status === 'passed',
						'border-error/30 bg-error/10 text-error':
							latest.status === 'failed' || latest.status === 'timed_out',
						'border-brand/30 bg-brand/10 text-brand': isInFlight,
					}"
				>
					<Icon
						:name="
							latest.status === 'passed'
								? 'lucide:check'
								: latest.status === 'failed' || latest.status === 'timed_out'
									? 'lucide:x'
									: 'lucide:loader-2'
						"
						class="h-3.5 w-3.5"
						:class="{ 'animate-spin motion-reduce:animate-none': isInFlight }"
					/>
					{{ latestStatusLabel }}
				</span>
			</div>
		</template>

		<div class="space-y-5 p-5 sm:p-6">
			<p class="max-w-3xl text-sm leading-6 text-text-secondary">
				{{ t('components.delivery.deliverabilityLoopbackCard.intro') }}
			</p>

			<label class="block min-w-0 sm:max-w-sm">
				<span class="mb-1.5 block text-sm font-medium text-text-primary">
					{{ t('components.delivery.deliverabilityLoopbackCard.sendingDomain') }}
				</span>
				<select
					v-model="selectedDomainId"
					class="input w-full"
					:disabled="isStarting || isInFlight"
				>
					<option v-for="domain in domains" :key="domain.id" :value="domain.id">
						{{ domain.domain }}
					</option>
				</select>
			</label>

			<div
				v-if="selectedDomain && !selectedDomain.eligible"
				class="flex items-start gap-3 rounded-lg border border-border-subtle bg-bg-surface p-4"
			>
				<Icon name="lucide:lock-keyhole" class="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary" />
				<div>
					<p class="text-sm font-medium text-text-primary">
						{{ t('components.delivery.deliverabilityLoopbackCard.lockedTitle') }}
					</p>
					<p class="mt-1 text-sm text-text-secondary">
						{{
							selectedDomain.blockedReason ??
							t('components.delivery.deliverabilityLoopbackCard.lockedDefaultReason')
						}}
					</p>
				</div>
			</div>

			<div v-else class="flex flex-col gap-3 sm:flex-row sm:items-end">
				<UiButton
					:loading="isStarting || isInFlight"
					:disabled="
						!selectedDomainId ||
						!selectedDomain?.eligible ||
						isStarting ||
						isInFlight ||
						domains.length === 0
					"
					@click="start"
				>
					<template #iconLeft>
						<Icon v-if="!isStarting && !isInFlight" name="lucide:send" class="h-4 w-4" />
					</template>
					{{
						isInFlight
							? t('components.delivery.deliverabilityLoopbackCard.running')
							: t('components.delivery.deliverabilityLoopbackCard.run')
					}}
				</UiButton>
			</div>

			<div
				v-if="latest && !isInFlight"
				class="rounded-xl border border-border-subtle bg-bg-deep/30 p-4 sm:p-5"
			>
				<h3 class="font-semibold text-text-primary">
					{{
						latest.status === 'passed'
							? t('components.delivery.deliverabilityLoopbackCard.resultPassedTitle')
							: t('components.delivery.deliverabilityLoopbackCard.resultFailedTitle')
					}}
				</h3>
				<p class="mt-1 text-xs text-text-tertiary">
					{{
						t('components.delivery.deliverabilityLoopbackCard.resultFor', { domain: latest.domain })
					}}
				</p>
				<p v-if="latest.detail" class="mt-1 text-sm text-text-secondary">{{ latest.detail }}</p>

				<div class="mt-4 grid gap-3 sm:grid-cols-3">
					<div
						v-for="result in resultItems"
						:key="result.key"
						class="rounded-lg border border-border-subtle bg-bg-surface p-3"
					>
						<Icon
							:name="resultIcon[result.value!]"
							class="h-5 w-5"
							:class="resultClass[result.value!]"
						/>
						<p class="mt-2 text-sm font-medium text-text-primary">{{ result.label }}</p>
						<p class="mt-0.5 text-xs text-text-secondary">
							{{
								result.value === 'pass'
									? t('components.delivery.deliverabilityLoopbackCard.mechanismStatus.pass')
									: result.value === 'fail'
										? t('components.delivery.deliverabilityLoopbackCard.mechanismStatus.fail')
										: t('components.delivery.deliverabilityLoopbackCard.mechanismStatus.unknown')
							}}
							<span v-if="result.detail"> · {{ result.detail }}</span>
						</p>
					</div>
				</div>

				<dl class="mt-4 grid gap-3 text-sm sm:grid-cols-2">
					<div v-if="latest.tlsVersion">
						<dt class="text-text-tertiary">
							{{ t('components.delivery.deliverabilityLoopbackCard.tlsVersion') }}
						</dt>
						<dd class="font-medium text-text-primary">{{ latest.tlsVersion }}</dd>
					</div>
					<div v-if="latest.sendingIp">
						<dt class="text-text-tertiary">
							{{ t('components.delivery.deliverabilityLoopbackCard.sendingIp') }}
						</dt>
						<dd class="break-all font-mono text-xs text-text-primary">
							{{ latest.sendingIp }}
							<span v-if="latest.ptr"> / {{ latest.ptr }}</span>
						</dd>
					</div>
				</dl>
			</div>
		</div>
	</UiCard>
</template>
