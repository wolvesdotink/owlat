<script setup lang="ts">
/**
 * Why a sending campaign is not sending: the workspace's sending is suspended
 * or disabled, so the walker and the worker hold its mail. Or, afterwards, that
 * the hold outlasted the delivery deadline and the rest was never mailed.
 *
 * A held campaign resumes by itself once sending is restored, so the notice
 * offers no action on the campaign; the account status lives on the delivery
 * hub, which is admin-only (`middleware/admin.ts`). A member gets "ask an
 * admin" instead of a link that would bounce them to Home.
 */
import type { FunctionReturnType } from 'convex/server';
// TYPE-ONLY: the notice needs the query's return shape, never the client.
import type { api } from '@owlat/api';
import { CircleWarningIcon } from '@coolicons/vue';

type SendHold = NonNullable<FunctionReturnType<typeof api.campaigns.sendHold.getCampaignSendHold>>;

const props = defineProps<{ hold: SendHold | null | undefined }>();

const { t } = useI18n();
const { isAdmin } = usePermissions();

const prefix = 'components.campaigns.campaignSendHoldNotice';

const copy = computed(() => {
	const hold = props.hold;
	if (!hold) return null;
	if (hold.kind === 'stopped') {
		return {
			title: t(`${prefix}.titleStopped`),
			body: t(`${prefix}.stopped`, { date: formatDateTime(hold.at), days: hold.holdDays }),
			since: null,
		};
	}
	return {
		title: t(`${prefix}.title`),
		body: t(hold.status === 'banned' ? `${prefix}.heldBanned` : `${prefix}.heldSuspended`, {
			days: hold.holdDays,
		}),
		since:
			hold.since === undefined
				? null
				: t(`${prefix}.heldSince`, { date: formatDateTime(hold.since) }),
	};
});
</script>

<template>
	<div
		v-if="copy"
		role="status"
		class="mb-8 flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm"
		data-testid="campaign-send-hold-notice"
	>
		<CircleWarningIcon class="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
		<div class="min-w-0 space-y-1">
			<p class="font-medium text-text-primary">{{ copy.title }}</p>
			<p class="text-text-secondary">{{ copy.body }}</p>
			<p v-if="copy.since" class="text-text-tertiary">{{ copy.since }}</p>
			<NuxtLink
				v-if="isAdmin"
				to="/dashboard/admin/delivery"
				class="link font-medium"
				data-testid="campaign-send-hold-fix"
			>
				{{ t('shared.campaignRefusal.fix.deliveryHub') }}
			</NuxtLink>
			<p v-else class="text-text-secondary">{{ t('shared.campaignRefusal.askAdmin') }}</p>
		</div>
	</div>
</template>
