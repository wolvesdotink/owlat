<script setup lang="ts">
import { api } from '@owlat/api';
import type { DestinationProviderKey } from '@owlat/shared/deliverabilityRouting';
import { GENERIC_IMAP_PROVIDER, providerById, type MailProvider } from '~/utils/mailAutodiscover';

const { t } = useI18n();
const {
	data: status,
	isLoading: statusLoading,
	error: statusError,
	refetch: refetchStatus,
} = useOrganizationQuery(api.delivery.observabilityStatus.get);
/**
 * Counts are read only from a delivered status: before it arrives (or when it
 * failed) "0 test mailboxes" would be a claim about connections that may exist.
 */
const statusPending = computed(() => !status.value && !statusError.value);
const { showToast } = useToast();
const acknowledgeRotation = useBackendOperation(
	api.mail.external.accountsSeed.acknowledgeSeedRotation,
	{ label: () => t('components.delivery.deliveryMeasurementCoverageCard.acknowledgeOperation') }
);
// Retiring a seed. The connect cap ("disconnect one before connecting another")
// pointed at an action the product did not have, so the row that measures
// nothing any more could never be cleared out of the way.
const disconnectSeedOp = useBackendOperation(api.mail.external.accountsSeed.disconnectSeed, {
	label: () => t('components.delivery.deliveryMeasurementCoverageCard.disconnectOperation'),
});
type SeedAccount = NonNullable<typeof status.value>['seedMailboxes']['accounts'][number];
/** The row whose "credentials rotated" write is in flight, so only it spins. */
const acknowledgingId = ref<SeedAccount['accountId'] | null>(null);
async function acknowledge(account: SeedAccount) {
	acknowledgingId.value = account.accountId;
	try {
		await acknowledgeRotation.run({ accountId: account.accountId });
	} finally {
		acknowledgingId.value = null;
	}
}
const seedToDisconnect = ref<SeedAccount | null>(null);
async function confirmDisconnectSeed() {
	const target = seedToDisconnect.value;
	if (!target) return;
	const result = await disconnectSeedOp.run({ accountId: target.accountId });
	seedToDisconnect.value = null;
	if (!result.ok) return;
	showToast(
		t('components.delivery.deliveryMeasurementCoverageCard.toastDisconnected', {
			address: target.address,
		})
	);
}

const detailsOpen = ref(false);
const showConnect = ref(false);
const selectedProvider = ref<DestinationProviderKey | null>(null);
// Computed rather than a frozen array: four of the five labels are product names
// and the fifth is a translated word, which a locale switch has to reach.
const providerOptions = computed<Array<{ key: DestinationProviderKey; label: string }>>(() => [
	{ key: 'gmail', label: 'Gmail' },
	{ key: 'microsoft', label: 'Microsoft' },
	{ key: 'yahoo', label: 'Yahoo' },
	{ key: 'apple', label: 'Apple' },
	{ key: 'other', label: t('components.delivery.deliveryMeasurementCoverageCard.providers.other') },
]);
const selectedMailProvider = computed<MailProvider>(() => {
	switch (selectedProvider.value) {
		case 'gmail':
			return providerById('gmail') ?? GENERIC_IMAP_PROVIDER;
		case 'microsoft':
			return providerById('outlook') ?? GENERIC_IMAP_PROVIDER;
		case 'yahoo':
			return providerById('yahoo') ?? GENERIC_IMAP_PROVIDER;
		case 'apple':
			return providerById('icloud') ?? GENERIC_IMAP_PROVIDER;
		default:
			return GENERIC_IMAP_PROVIDER;
	}
});
const microsoftFeedback = computed(() => {
	if (!status.value?.microsoftFeedback.configured)
		return t('components.delivery.deliveryMeasurementCoverageCard.noFeedConfigured');
	return t(
		'components.delivery.deliveryMeasurementCoverageCard.feedsConfigured',
		status.value.microsoftFeedback.feedCount
	);
});

/** The provider as its product name, never the raw key. */
function providerName(provider: string): string {
	return providerOptions.value.find((option) => option.key === provider)?.label ?? provider;
}

function finishConnect() {
	showConnect.value = false;
	selectedProvider.value = null;
}
</script>

<template>
	<UiCard>
		<div class="flex items-start justify-between gap-4">
			<div>
				<h2 class="text-lg font-semibold text-text-primary">
					{{ t('components.delivery.deliveryMeasurementCoverageCard.title') }}
				</h2>
				<UiSkeleton v-if="statusPending" class="mt-2 h-4 w-64 max-w-full" />
				<p v-else-if="status" class="mt-1 text-sm text-text-secondary">
					{{
						t('components.delivery.deliveryMeasurementCoverageCard.summary', {
							count: status?.seedMailboxes.connected ?? 0,
							feedback: status?.microsoftFeedback.configured
								? t('components.delivery.deliveryMeasurementCoverageCard.feedbackConnected')
								: t('components.delivery.deliveryMeasurementCoverageCard.feedbackNotConnected'),
						})
					}}
				</p>
			</div>
			<UiBadge v-if="status" :variant="status.seedMailboxes.connected ? 'success' : 'neutral'">
				{{
					status?.seedMailboxes.connected
						? t('components.delivery.deliveryMeasurementCoverageCard.measured')
						: t('common.optional')
				}}
			</UiBadge>
		</div>
		<UiQueryBoundary v-if="statusError && !status" :error="statusError" @retry="refetchStatus" />
		<UiDisclosure
			v-else-if="status"
			v-model="detailsOpen"
			class="mt-4"
			:label="t('components.delivery.deliveryMeasurementCoverageCard.detailsLabel')"
		>
			<div class="grid gap-3 sm:grid-cols-2 text-sm">
				<div class="rounded-lg bg-bg-surface p-3">
					<p class="font-medium text-text-primary">
						{{ t('components.delivery.deliveryMeasurementCoverageCard.testMailboxes') }}
					</p>
					<p class="mt-1 text-text-secondary">
						{{
							t('components.delivery.deliveryMeasurementCoverageCard.mailboxCounts', {
								connected: status?.seedMailboxes.connected ?? 0,
								due: status?.seedMailboxes.rotationRemindersDue ?? 0,
							})
						}}
					</p>
				</div>
				<div class="rounded-lg bg-bg-surface p-3">
					<p class="font-medium text-text-primary">
						{{ t('components.delivery.deliveryMeasurementCoverageCard.microsoftFeedback') }}
					</p>
					<p class="mt-1 text-text-secondary">{{ microsoftFeedback }}</p>
				</div>
			</div>
			<div class="mt-4 border-t border-border-subtle pt-4">
				<div class="flex items-center justify-between gap-3">
					<p class="text-sm font-medium text-text-primary">
						{{ t('components.delivery.deliveryMeasurementCoverageCard.accountsTitle') }}
					</p>
					<UiButton v-if="!showConnect" size="sm" variant="secondary" @click="showConnect = true">
						{{ t('components.delivery.deliveryMeasurementCoverageCard.addMailbox') }}
					</UiButton>
				</div>
				<div v-if="status?.seedMailboxes.accounts.length" class="mt-3 space-y-2">
					<div
						v-for="account in status.seedMailboxes.accounts"
						:key="account.accountId"
						class="flex items-center justify-between gap-3 rounded-lg bg-bg-surface p-3"
					>
						<div class="min-w-0">
							<p class="truncate text-sm font-medium text-text-primary">{{ account.address }}</p>
							<p class="text-xs text-text-tertiary">{{ providerName(account.provider) }}</p>
						</div>
						<div class="flex items-center gap-2 shrink-0">
							<UiButton
								v-if="account.rotationReminderDue"
								size="sm"
								variant="secondary"
								:loading="acknowledgingId === account.accountId"
								@click="acknowledge(account)"
							>
								{{ t('components.delivery.deliveryMeasurementCoverageCard.credentialsRotated') }}
							</UiButton>
							<UiButton
								size="sm"
								variant="danger-ghost"
								data-testid="seed-disconnect"
								:aria-label="
									t('components.delivery.deliveryMeasurementCoverageCard.disconnectAriaLabel', {
										address: account.address,
									})
								"
								@click="seedToDisconnect = account"
							>
								{{ t('components.delivery.deliveryMeasurementCoverageCard.disconnect') }}
							</UiButton>
						</div>
					</div>
				</div>
				<div v-if="showConnect" class="mt-4 rounded-lg border border-border-subtle p-4">
					<template v-if="!selectedProvider">
						<div class="grid gap-2 sm:grid-cols-3">
							<UiButton
								v-for="provider in providerOptions"
								:key="provider.key"
								variant="secondary"
								@click="selectedProvider = provider.key"
							>
								{{ provider.label }}
							</UiButton>
						</div>
						<div class="mt-3 flex justify-end">
							<UiButton
								size="sm"
								variant="ghost"
								data-testid="seed-connect-cancel"
								@click="finishConnect"
							>
								{{ t('common.cancel') }}
							</UiButton>
						</div>
					</template>
					<PostboxMailboxConnectForm
						v-else
						:provider="selectedMailProvider"
						mode="connect"
						:seed-provider="selectedProvider"
						@submitted="finishConnect"
						@cancel="finishConnect"
					/>
				</div>
			</div>
		</UiDisclosure>

		<UiConfirmationDialog
			:open="seedToDisconnect !== null"
			:title="t('components.delivery.deliveryMeasurementCoverageCard.disconnectDialogTitle')"
			:description="
				t('components.delivery.deliveryMeasurementCoverageCard.disconnectDialogDescription', {
					address: seedToDisconnect?.address ?? '',
				})
			"
			:confirm-text="t('components.delivery.deliveryMeasurementCoverageCard.disconnect')"
			variant="warning"
			:is-loading="disconnectSeedOp.isLoading.value"
			@confirm="confirmDisconnectSeed"
			@cancel="seedToDisconnect = null"
			@update:open="seedToDisconnect = $event ? seedToDisconnect : null"
		/>
	</UiCard>
</template>
