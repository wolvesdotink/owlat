<script setup lang="ts">
/**
 * Marketing notifications: one switch per kind (campaign finished, scheduled
 * campaign about to send, bounce protection, automation problems, sending domain
 * DNS broken). The switches are the person's own and live on the server, so
 * they hold for the app, the desktop app and Web Push on every device alike.
 *
 * Only the switches that can ever fire for this person on this instance are
 * listed (the DNS one is admin-only, the automation one needs automations),
 * and the card hides itself when none can.
 */
import { api } from '@owlat/api';

type Preference =
	| 'campaignFinished'
	| 'campaignReminder'
	| 'deliveryHold'
	| 'automationProblems'
	| 'domainDns';

const COPY_KEYS: Record<Preference, { label: string; hint: string }> = {
	campaignFinished: {
		label: 'components.preferences.marketingNotifications.campaignFinished.label',
		hint: 'components.preferences.marketingNotifications.campaignFinished.hint',
	},
	campaignReminder: {
		label: 'components.preferences.marketingNotifications.campaignReminder.label',
		hint: 'components.preferences.marketingNotifications.campaignReminder.hint',
	},
	deliveryHold: {
		label: 'components.preferences.marketingNotifications.deliveryHold.label',
		hint: 'components.preferences.marketingNotifications.deliveryHold.hint',
	},
	automationProblems: {
		label: 'components.preferences.marketingNotifications.automationProblems.label',
		hint: 'components.preferences.marketingNotifications.automationProblems.hint',
	},
	domainDns: {
		label: 'components.preferences.marketingNotifications.domainDns.label',
		hint: 'components.preferences.marketingNotifications.domainDns.hint',
	},
};

const { t } = useI18n();

const { data } = useConvexQuery(api.marketing.notifications.getMyPreferences, () => ({}));
const { run: savePreference } = useBackendOperation(api.marketing.notifications.setMyPreference, {
	label: () => t('components.preferences.marketingNotifications.saveOperation'),
});

/** The switch whose write is in flight; the others wait for it. */
const savingPreference = ref<Preference | null>(null);

async function toggle(preference: Preference, enabled: boolean): Promise<void> {
	if (savingPreference.value) return;
	savingPreference.value = preference;
	try {
		await savePreference({ preference, enabled });
	} finally {
		savingPreference.value = null;
	}
}
</script>

<template>
	<section
		v-if="data && data.kinds.length > 0"
		id="marketing-notifications"
		class="card !p-0 mb-6 scroll-mt-6 overflow-hidden"
	>
		<header class="px-5 py-3 border-b border-border-subtle">
			<div class="flex items-center justify-between gap-3">
				<h2 class="font-semibold">
					{{ t('components.preferences.marketingNotifications.heading') }}
				</h2>
				<!-- The page around this card is about this device; these switches
				     are not, so the card says where they are kept. -->
				<UiBadge variant="neutral">
					{{ t('components.preferences.marketingNotifications.scopeBadge') }}
				</UiBadge>
			</div>
			<p class="text-xs text-text-tertiary mt-0.5">
				{{ t('components.preferences.marketingNotifications.intro') }}
			</p>
		</header>
		<div
			v-for="(preference, index) in data.kinds"
			:key="preference"
			class="px-5 py-4 flex items-center justify-between gap-4"
			:class="{ 'border-t border-border-subtle': index > 0 }"
		>
			<div class="min-w-0">
				<label :for="`marketing-notify-${preference}`" class="font-medium text-sm block">
					{{ t(COPY_KEYS[preference].label) }}
				</label>
				<p class="text-xs text-text-tertiary mt-0.5">
					{{ t(COPY_KEYS[preference].hint) }}
				</p>
			</div>
			<UiSwitch
				:id="`marketing-notify-${preference}`"
				:model-value="data.enabled[preference]"
				:disabled="savingPreference !== null"
				@update:model-value="toggle(preference, $event)"
			/>
		</div>
	</section>
</template>
