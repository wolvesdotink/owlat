<script setup lang="ts">
import { api } from '@owlat/api';
import type { DestinationProviderKey } from '@owlat/shared/deliverabilityRouting';
import { GENERIC_IMAP_PROVIDER, providerById, type MailProvider } from '~/utils/mailAutodiscover';

const { data: status } = useOrganizationQuery(api.delivery.observabilityStatus.get);
const acknowledgeRotation = useBackendOperation(
	api.mail.externalAccountsSeed.acknowledgeSeedRotation,
	{ label: 'Acknowledge credential rotation' }
);
const detailsOpen = ref(false);
const showConnect = ref(false);
const selectedProvider = ref<DestinationProviderKey | null>(null);
const providerOptions: Array<{ key: DestinationProviderKey; label: string }> = [
	{ key: 'gmail', label: 'Gmail' },
	{ key: 'microsoft', label: 'Microsoft' },
	{ key: 'yahoo', label: 'Yahoo' },
	{ key: 'apple', label: 'Apple' },
	{ key: 'other', label: 'Other' },
];
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
		return 'No feed configured; sending remains available.';
	const count = status.value.microsoftFeedback.feedCount;
	return count + ' feed' + (count === 1 ? '' : 's') + ' configured';
});

function finishConnect() {
	showConnect.value = false;
	selectedProvider.value = null;
}
</script>

<template>
	<UiCard>
		<div class="flex items-start justify-between gap-4">
			<div>
				<h2 class="text-lg font-semibold text-text-primary">Measurement coverage</h2>
				<p class="mt-1 text-sm text-text-secondary">
					{{ status?.seedMailboxes.connected ?? 0 }} test mailboxes connected · Microsoft feedback
					{{ status?.microsoftFeedback.configured ? 'connected' : 'not connected' }}
				</p>
			</div>
			<UiBadge :variant="status?.seedMailboxes.connected ? 'success' : 'neutral'">
				{{ status?.seedMailboxes.connected ? 'Measured' : 'Optional' }}
			</UiBadge>
		</div>
		<UiDisclosure v-model="detailsOpen" class="mt-4" label="Measurement details">
			<div class="grid gap-3 sm:grid-cols-2 text-sm">
				<div class="rounded-lg bg-bg-surface p-3">
					<p class="font-medium text-text-primary">Test mailboxes</p>
					<p class="mt-1 text-text-secondary">
						{{ status?.seedMailboxes.connected ?? 0 }} connected;
						{{ status?.seedMailboxes.rotationRemindersDue ?? 0 }} need credential rotation.
					</p>
				</div>
				<div class="rounded-lg bg-bg-surface p-3">
					<p class="font-medium text-text-primary">Microsoft sender feedback</p>
					<p class="mt-1 text-text-secondary">{{ microsoftFeedback }}</p>
				</div>
			</div>
			<div class="mt-4 border-t border-border-subtle pt-4">
				<div class="flex items-center justify-between gap-3">
					<p class="text-sm font-medium text-text-primary">Test mailbox accounts</p>
					<UiButton v-if="!showConnect" size="sm" variant="secondary" @click="showConnect = true">
						Add test mailbox
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
							<p class="text-xs capitalize text-text-tertiary">{{ account.provider }}</p>
						</div>
						<UiButton
							v-if="account.rotationReminderDue"
							size="sm"
							variant="secondary"
							:loading="acknowledgeRotation.isLoading.value"
							@click="acknowledgeRotation.run({ accountId: account.accountId })"
						>
							Credentials rotated
						</UiButton>
					</div>
				</div>
				<div v-if="showConnect" class="mt-4 rounded-lg border border-border-subtle p-4">
					<div v-if="!selectedProvider" class="grid gap-2 sm:grid-cols-3">
						<UiButton
							v-for="provider in providerOptions"
							:key="provider.key"
							variant="secondary"
							@click="selectedProvider = provider.key"
						>
							{{ provider.label }}
						</UiButton>
					</div>
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
	</UiCard>
</template>
