<script setup lang="ts">
/**
 * Where deliverability alerts go, on the Deliverability Center: one line
 * ("Email to 2 people · In app for 2 people · Push on 1 device · Webhook not
 * set") and, one click away, a row per channel with the one action that fixes
 * it, and a test through all of them.
 *
 * The email may leave through the server an alert is about; the in-app notice,
 * push and the alert webhook do not. Naming them side by side is what tells an admin whether a
 * blocked port 25 would still reach anyone. The in-app notice and push share
 * the caller's "Deliverability alerts" switch, so turning it off here is the
 * same write as in Preferences.
 */
import { api } from '@owlat/api';
import { BellIcon } from '@coolicons/vue';
import { DELIVERABILITY_ALERT_WEBHOOK_PRESET } from '~/utils/webhookPresets';

const K = 'components.delivery.deliverabilityAlertChannels';
const PUSH_DOCS_URL =
	'https://docs.owlat.app/developer/environment-variables#optional-web-push-notifications';

const { t } = useI18n();
const { isDesktop } = useDesktopContext();
const { data: channels } = useOrganizationQuery(api.delivery.checklistAlertChannels.getChannels);
const { run: savePreference } = useBackendOperation(api.marketing.notifications.setMyPreference, {
	label: () => t(`${K}.saveOperation`),
});

const isSaving = ref(false);
async function setMySwitch(enabled: boolean): Promise<void> {
	if (isSaving.value) return;
	isSaving.value = true;
	try {
		await savePreference({ preference: 'deliverabilityAlerts', enabled });
	} finally {
		isSaving.value = false;
	}
}

const emailReaches = computed(
	() =>
		!!channels.value?.email.isSenderConfigured && (channels.value?.email.recipientCount ?? 0) > 0
);
const pushReaches = computed(
	() => !!channels.value?.push.isConfigured && (channels.value?.push.deviceCount ?? 0) > 0
);

const summary = computed(() => {
	const c = channels.value;
	if (!c) return '';
	return [
		emailReaches.value
			? t(`${K}.summary.email`, c.email.recipientCount)
			: t(`${K}.summary.noEmail`),
		c.inApp.recipientCount > 0
			? t(`${K}.summary.inApp`, c.inApp.recipientCount)
			: t(`${K}.summary.noInApp`),
		pushReaches.value ? t(`${K}.summary.push`, c.push.deviceCount) : t(`${K}.summary.noPush`),
		c.webhook.count > 0
			? t(`${K}.summary.webhook`, c.webhook.count)
			: c.webhook.cleartextCount > 0
				? t(`${K}.summary.webhookCleartext`)
				: t(`${K}.summary.noWebhook`),
	].join(' · ');
});

const emailDetail = computed(() => {
	const email = channels.value?.email;
	if (!email) return '';
	if (!email.isSenderConfigured) return t(`${K}.email.noSender`);
	if (email.recipientCount === 0) return t(`${K}.email.noRecipient`);
	const reach = t(`${K}.email.reach`, email.recipientCount);
	return email.isOnOwnMta ? `${reach} ${t(`${K}.email.ownServer`)}` : reach;
});

const pushDetail = computed(() => {
	const push = channels.value?.push;
	if (!push) return '';
	if (!push.isConfigured) return t(`${K}.push.notConfigured`);
	if (push.deviceCount === 0) return t(`${K}.push.noDevice`);
	return t(`${K}.push.reach`, push.deviceCount);
});

const webhookDetail = computed(() => {
	const webhook = channels.value?.webhook;
	if (!webhook) return '';
	if (!webhook.isFeatureOn) return t(`${K}.webhook.off`);
	// A stored http:// URL gets no alerts (webhooks/urlPolicy.ts); saying so
	// keeps the operator from counting it as a channel.
	const cleartext =
		webhook.cleartextCount > 0 ? t(`${K}.webhook.cleartext`, webhook.cleartextCount) : '';
	if (webhook.count === 0) return cleartext || t(`${K}.webhook.notSet`);
	return [t(`${K}.webhook.reach`, webhook.count), cleartext].filter(Boolean).join(' ');
});

const hasWebhookToManage = computed(() => {
	const webhook = channels.value?.webhook;
	return !webhook?.isFeatureOn || webhook.count > 0 || webhook.cleartextCount > 0;
});
</script>

<template>
	<section
		v-if="channels"
		class="card !p-0 overflow-hidden"
		aria-labelledby="deliverability-alert-channels-heading"
	>
		<details class="group">
			<summary
				class="flex cursor-pointer list-none items-start gap-3 px-5 py-4 focus-visible:outline-2 focus-visible:outline-brand sm:px-6"
			>
				<BellIcon class="mt-0.5 h-5 w-5 shrink-0 text-text-tertiary" aria-hidden="true" />
				<div class="min-w-0 flex-1">
					<h2 id="deliverability-alert-channels-heading" class="font-medium text-text-primary">
						{{ t(`${K}.heading`) }}
					</h2>
					<p class="mt-0.5 text-sm text-text-secondary" data-testid="alert-channels-summary">
						{{ summary }}
					</p>
				</div>
				<span class="shrink-0 text-sm text-brand group-open:hidden">{{ t(`${K}.show`) }}</span>
				<span class="hidden shrink-0 text-sm text-brand group-open:inline">{{
					t(`${K}.hide`)
				}}</span>
			</summary>

			<ul class="divide-y divide-border-subtle border-t border-border-subtle">
				<li
					class="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6"
				>
					<div class="min-w-0">
						<h3 class="text-sm font-medium text-text-primary">{{ t(`${K}.email.title`) }}</h3>
						<p class="mt-0.5 text-xs text-text-tertiary" data-testid="alert-channel-email">
							{{ emailDetail }}
						</p>
					</div>
					<UiButton
						size="sm"
						variant="secondary"
						:to="
							channels.email.isSenderConfigured
								? '/dashboard/admin/team'
								: '/dashboard/admin/delivery/transport'
						"
					>
						{{
							channels.email.isSenderConfigured
								? t(`${K}.email.manageTeam`)
								: t(`${K}.email.setUpSender`)
						}}
					</UiButton>
				</li>
				<li
					class="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6"
				>
					<div class="min-w-0">
						<h3 class="text-sm font-medium text-text-primary">{{ t(`${K}.inApp.title`) }}</h3>
						<p class="mt-0.5 text-xs text-text-tertiary" data-testid="alert-channel-in-app">
							{{
								channels.inApp.recipientCount > 0
									? t(`${K}.inApp.reach`, channels.inApp.recipientCount)
									: t(`${K}.inApp.nobody`)
							}}
							{{ channels.me.isSwitchOn ? t(`${K}.inApp.mineOn`) : t(`${K}.inApp.mineOff`) }}
						</p>
					</div>
					<UiButton
						size="sm"
						variant="secondary"
						:loading="isSaving"
						data-testid="alert-channel-my-switch"
						@click="setMySwitch(!channels.me.isSwitchOn)"
					>
						{{ channels.me.isSwitchOn ? t(`${K}.inApp.turnOff`) : t(`${K}.inApp.turnOn`) }}
					</UiButton>
				</li>
				<li
					class="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6"
				>
					<div class="min-w-0">
						<h3 class="text-sm font-medium text-text-primary">{{ t(`${K}.push.title`) }}</h3>
						<p class="mt-0.5 text-xs text-text-tertiary" data-testid="alert-channel-push">
							{{ pushDetail }}
						</p>
					</div>
					<UiButton
						v-if="!channels.push.isConfigured"
						size="sm"
						variant="secondary"
						:href="PUSH_DOCS_URL"
						target="_blank"
						rel="noopener"
					>
						{{ t(`${K}.push.setUpServer`) }}
					</UiButton>
					<!-- The desktop app has no Web Push; it turns the in-app notice
					     into a system notification instead. -->
					<p v-else-if="isDesktop" class="text-xs text-text-tertiary">
						{{ t(`${K}.push.desktop`) }}
					</p>
					<UiButton
						v-else-if="channels.me.deviceCount === 0"
						size="sm"
						variant="secondary"
						to="/dashboard/preferences/device#push"
					>
						{{ t(`${K}.push.setUpDevice`) }}
					</UiButton>
				</li>
				<li
					class="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6"
				>
					<div class="min-w-0">
						<h3 class="text-sm font-medium text-text-primary">{{ t(`${K}.webhook.title`) }}</h3>
						<p
							class="mt-0.5 text-xs"
							:class="channels.webhook.cleartextCount > 0 ? 'text-warning' : 'text-text-tertiary'"
							data-testid="alert-channel-webhook"
						>
							{{ webhookDetail }}
						</p>
					</div>
					<UiButton
						size="sm"
						variant="secondary"
						:to="
							hasWebhookToManage
								? '/dashboard/admin/delivery/webhooks'
								: `/dashboard/admin/delivery/webhooks?preset=${DELIVERABILITY_ALERT_WEBHOOK_PRESET}`
						"
					>
						{{ hasWebhookToManage ? t(`${K}.webhook.manage`) : t(`${K}.webhook.add`) }}
					</UiButton>
				</li>
				<li>
					<DeliveryDeliverabilityAlertTestPanel />
				</li>
			</ul>
		</details>
	</section>
</template>
