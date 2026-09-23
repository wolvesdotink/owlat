<script setup lang="ts">
/**
 * "Require TLS for incoming mail" — an inbound transport rule: senders that try
 * to deliver to this instance's mailboxes without STARTTLS get a permanent
 * `550 5.7.10` and the message is never accepted.
 *
 * It lived on the Sealed mail page, which is about end-to-end encryption
 * between workspaces — a different thing, and not where an admin looks for a
 * receiving rule. It sits in the Delivery provider page's "Incoming mail"
 * section now, beside MTA-STS and trusted forwarders.
 *
 * The rule is registered with each hosted mailbox, so it only means something
 * when hosted mailboxes exist; the card is not shown otherwise.
 */
import { api } from '@owlat/api';

const { t } = useI18n();
const { isEnabled: isFeatureEnabled } = useFeatureFlag();

const hasHostedMail = computed(() => isFeatureEnabled('postbox'));

const { data: settings } = useOrganizationQuery(api.workspaces.settings.get);

// Local mirror so the switch feels instant; the query re-emits the stored value.
// Unset ⇒ required (the backend's default).
const isRequired = ref(true);
watch(
	settings,
	(value) => {
		isRequired.value = value?.isInboundTlsRequired !== false;
	},
	{ immediate: true }
);

const { run: saveSettings, isLoading: saving } = useBackendOperation(
	api.workspaces.settings.update,
	{ label: () => t('components.delivery.inboundTlsRequirementCard.updateOperation') }
);

async function setRequired(value: boolean) {
	if (value === isRequired.value) return;
	const previous = isRequired.value;
	isRequired.value = value;
	const result = await saveSettings({ isInboundTlsRequired: value });
	if (!result.ok) isRequired.value = previous;
}
</script>

<template>
	<UiCard v-if="hasHostedMail" data-testid="inbound-tls-card">
		<div class="flex items-start justify-between gap-4">
			<div class="flex min-w-0 items-start gap-3">
				<UiIconBox icon="lucide:lock-keyhole" size="sm" variant="surface" rounded="lg" />
				<div class="min-w-0">
					<h3 class="text-lg font-semibold text-text-primary">
						{{ t('components.delivery.inboundTlsRequirementCard.title') }}
					</h3>
					<p class="mt-1 text-sm text-text-secondary">
						{{ t('components.delivery.inboundTlsRequirementCard.description') }}
					</p>
					<p
						v-if="!isRequired"
						class="mt-2 text-xs text-warning"
						data-testid="inbound-tls-plaintext-warning"
					>
						{{ t('components.delivery.inboundTlsRequirementCard.plaintextWarning') }}
					</p>
				</div>
			</div>
			<UiToggle
				:model-value="isRequired"
				:disabled="saving || settings === undefined"
				:label="isRequired ? t('common.required') : t('common.optional')"
				data-testid="inbound-tls-required"
				@update:model-value="setRequired"
			/>
		</div>
	</UiCard>
</template>
