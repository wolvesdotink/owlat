<script setup lang="ts">
/**
 * Deliverability Center → the IPv6 section while outbound IPv6 is off.
 *
 * The six IPv6 checks are hidden until the MTA reports an IPv6 address; this
 * takes their place with one sentence saying IPv6 is off and optional, and a
 * setup flow: the operator names the address, Owlat checks its PTR, AAAA and
 * return-path SPF (`api.delivery.ipv6Setup.checkAddress`), and once all three
 * pass hands over the exact `.env` lines. The page flips to the IPv6 checks by
 * itself when the MTA reports the address, so nothing here waits or polls.
 */
import { api } from '@owlat/api';
import type { DeliverabilityChecklistGroup } from '~/utils/deliverabilityCenter';
import {
	IPV6_APPLY_COMMANDS,
	IPV6_SETUP_ENV_NAMES,
	IPV6_SETUP_REFUSAL_KEYS,
	ipv4Blockers,
	ipv6CheckCopy,
	looksLikeIpv6,
	type Ipv6SetupResult,
} from '~/utils/ipv6Setup';
import { useDeliverabilityChecklistCopy } from '~/composables/useDeliverabilityChecklistCopy';
import DeliveryEnvSetupSteps from './EnvSetupSteps.vue';

const props = defineProps<{
	groups: DeliverabilityChecklistGroup[];
}>();

const { t } = useI18n();
const { itemTitle } = useDeliverabilityChecklistCopy();

const DOCS_HREF =
	'https://docs.owlat.app/guide/sending-from-a-vps#add-outbound-ipv6-only-after-ipv4-is-green';

const isOpen = ref(false);
const address = ref('');
const isAddressTouched = ref(false);
const result = ref<Ipv6SetupResult | null>(null);

const blockers = computed(() => ipv4Blockers(props.groups));
const addressError = computed(() =>
	isAddressTouched.value && address.value.trim() !== '' && !looksLikeIpv6(address.value)
		? t('components.delivery.deliverabilityIpv6Setup.addressInvalid')
		: undefined
);
const report = computed(() => (result.value?.ok ? result.value : null));

const { run: checkAddress, isLoading: isChecking } = useBackendOperation(
	api.delivery.ipv6Setup.checkAddress,
	{ label: () => t('components.delivery.deliverabilityIpv6Setup.operation'), type: 'action' }
);

async function check() {
	isAddressTouched.value = true;
	if (!looksLikeIpv6(address.value)) return;
	const response = await checkAddress({ address: address.value.trim() });
	if (response.ok) result.value = response.result;
}

// A new address makes the last answer stale.
watch(address, () => {
	result.value = null;
});
</script>

<template>
	<section aria-labelledby="ipv6-heading" data-testid="ipv6-sending">
		<div class="mb-2 flex items-start gap-3 px-1">
			<Icon name="lucide:globe" class="mt-0.5 h-5 w-5 shrink-0 text-text-tertiary" />
			<div>
				<h2 id="ipv6-heading" class="font-semibold text-text-primary">
					{{ t('components.delivery.deliverabilityIpv6Setup.title') }}
				</h2>
				<p class="text-sm text-text-secondary">
					{{ t('components.delivery.deliverabilityIpv6Setup.subtitle') }}
				</p>
			</div>
		</div>

		<div class="overflow-hidden rounded-xl border border-border-subtle bg-bg-elevated">
			<div class="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:px-5">
				<Icon
					name="lucide:circle-minus"
					class="hidden h-5 w-5 shrink-0 text-text-tertiary sm:block"
				/>
				<div class="min-w-0 flex-1">
					<p class="font-medium text-text-primary">
						{{ t('components.delivery.deliverabilityIpv6Setup.offTitle') }}
					</p>
					<p class="mt-0.5 text-sm text-text-secondary">
						{{ t('components.delivery.deliverabilityIpv6Setup.offBody') }}
					</p>
				</div>
				<UiButton
					size="sm"
					variant="secondary"
					:aria-expanded="isOpen"
					aria-controls="ipv6-setup"
					data-testid="ipv6-setup-open"
					@click="isOpen = !isOpen"
				>
					{{
						isOpen
							? t('components.delivery.deliverabilityIpv6Setup.closeSetup')
							: t('components.delivery.deliverabilityIpv6Setup.openSetup')
					}}
				</UiButton>
			</div>

			<div
				v-if="isOpen"
				id="ipv6-setup"
				class="space-y-5 border-t border-border-subtle bg-bg-deep/30 px-4 py-4 sm:px-5"
			>
				<div
					v-if="blockers.length"
					class="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/8 p-3 text-sm text-text-primary"
					role="note"
					data-testid="ipv6-ipv4-blockers"
				>
					<Icon name="lucide:circle-alert" class="mt-0.5 h-4 w-4 shrink-0 text-warning" />
					<p>
						{{
							t('components.delivery.deliverabilityIpv6Setup.ipv4Blocked', {
								checks: blockers.map((item) => itemTitle(item)).join(', '),
							})
						}}
					</p>
				</div>

				<ol class="space-y-5">
					<li class="flex gap-3">
						<span
							class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand/10 text-xs font-semibold text-brand"
							>1</span
						>
						<div class="min-w-0 flex-1 text-sm">
							<p class="font-medium text-text-primary">
								{{ t('components.delivery.deliverabilityIpv6Setup.step1Title') }}
							</p>
							<p class="mt-1 text-text-secondary">
								{{ t('components.delivery.deliverabilityIpv6Setup.step1Body') }}
							</p>
							<a
								:href="DOCS_HREF"
								target="_blank"
								rel="noopener noreferrer"
								class="mt-1 inline-block text-xs text-brand hover:underline"
							>
								{{ t('components.delivery.deliverabilityIpv6Setup.docsLink') }}
							</a>
						</div>
					</li>

					<li class="flex gap-3">
						<span
							class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand/10 text-xs font-semibold text-brand"
							>2</span
						>
						<div class="min-w-0 flex-1 space-y-3 text-sm">
							<p class="font-medium text-text-primary">
								{{ t('components.delivery.deliverabilityIpv6Setup.step2Title') }}
							</p>
							<form class="flex flex-col gap-3 sm:flex-row sm:items-start" @submit.prevent="check">
								<UiInput
									v-model="address"
									class="sm:max-w-sm sm:flex-1"
									:label="t('components.delivery.deliverabilityIpv6Setup.addressLabel')"
									placeholder="2001:db8::25"
									autocomplete="off"
									:error="addressError"
									data-testid="ipv6-address-input"
									@blur="isAddressTouched = true"
								/>
								<UiButton
									type="submit"
									size="sm"
									variant="secondary"
									class="sm:mt-6"
									:loading="isChecking"
									:disabled="isChecking || address.trim() === ''"
									data-testid="ipv6-check"
								>
									{{
										result
											? t('components.delivery.deliverabilityIpv6Setup.recheck')
											: t('components.delivery.deliverabilityIpv6Setup.check')
									}}
								</UiButton>
							</form>

							<p
								v-if="result && !result.ok"
								class="text-error"
								role="alert"
								data-testid="ipv6-refusal"
							>
								{{ t(IPV6_SETUP_REFUSAL_KEYS[result.refusal]) }}
							</p>
							<ul v-if="report" class="space-y-2" aria-live="polite" data-testid="ipv6-checks">
								<li v-for="item in report.checks" :key="item.id" class="flex items-start gap-2">
									<Icon
										:name="item.status === 'pass' ? 'lucide:check-circle-2' : 'lucide:x-circle'"
										class="mt-0.5 h-4 w-4 shrink-0"
										:class="item.status === 'pass' ? 'text-success' : 'text-error'"
									/>
									<span class="text-text-primary">
										{{ t(ipv6CheckCopy(item, report).key, ipv6CheckCopy(item, report).params) }}
									</span>
								</li>
							</ul>
						</div>
					</li>

					<li class="flex gap-3">
						<span
							class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand/10 text-xs font-semibold text-brand"
							>3</span
						>
						<div class="min-w-0 flex-1 space-y-3 text-sm">
							<p class="font-medium text-text-primary">
								{{ t('components.delivery.deliverabilityIpv6Setup.step3Title') }}
							</p>
							<template v-if="report?.ready">
								<p class="text-text-secondary">
									{{ t('components.delivery.deliverabilityIpv6Setup.step3Body') }}
								</p>
								<p
									v-if="!report.env.IP_POOLS_CAMPAIGN"
									class="text-text-secondary"
									data-testid="ipv6-pools-unknown"
								>
									{{
										t('components.delivery.deliverabilityIpv6Setup.poolsUnknown', {
											address: report.address,
										})
									}}
								</p>
								<DeliveryEnvSetupSteps
									:variables="IPV6_SETUP_ENV_NAMES"
									:values="report.env"
									:connected="false"
									:await-connection="false"
									:apply-commands="IPV6_APPLY_COMMANDS"
								/>
								<p class="text-text-secondary">
									{{ t('components.delivery.deliverabilityIpv6Setup.afterApply') }}
								</p>
							</template>
							<p v-else class="text-text-secondary">
								{{ t('components.delivery.deliverabilityIpv6Setup.step3Locked') }}
							</p>
						</div>
					</li>
				</ol>
			</div>
		</div>
	</section>
</template>
