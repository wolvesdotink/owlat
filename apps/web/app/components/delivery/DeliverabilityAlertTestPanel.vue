<script setup lang="ts">
/**
 * "Send test alert": one test through every channel a deliverability alert
 * uses, and a line per channel saying what happened. The email and push go to
 * the admin who pressed it; the webhook to every endpoint subscribed to
 * deliverability alerts. A webhook answers after the action returns, so its
 * line follows the delivery rows until they settle.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { FunctionReturnType } from 'convex/server';

type TestResult = FunctionReturnType<typeof api.delivery.checklistAlertTest.sendTestAlert>;

const K = 'components.delivery.deliverabilityAlertTestPanel';

const { t } = useI18n();
const { showToast } = useToast();
const { run: sendTest } = useBackendOperation(api.delivery.checklistAlertTest.sendTestAlert, {
	type: 'action',
	label: () => t(`${K}.operation`),
});

const result = ref<TestResult | null>(null);
const isSending = ref(false);

const webhookLogIds = computed<Id<'webhookDeliveryLogs'>[] | null>(() =>
	result.value?.webhook.status === 'queued' ? result.value.webhook.logIds : null
);
const { data: webhookOutcome } = useConvexQuery(
	api.delivery.checklistAlertTest.getTestWebhookResults,
	() => (webhookLogIds.value ? { logIds: webhookLogIds.value } : 'skip')
);

async function runTest(): Promise<void> {
	if (isSending.value) return;
	isSending.value = true;
	try {
		const outcome = await sendTest({});
		if (!outcome.ok) return;
		result.value = outcome.result;
		// The in-app channel is this page: the test shows where a real alert would.
		if (outcome.result.inApp.isSwitchOn) showToast(t(`${K}.toast`), 'warning');
	} finally {
		isSending.value = false;
	}
}

const lines = computed(() => {
	const r = result.value;
	if (!r) return [];
	const email =
		r.email.status === 'accepted'
			? { ok: true, text: t(`${K}.email.accepted`, { to: r.email.to }) }
			: r.email.status === 'failed'
				? { ok: false, text: t(`${K}.email.failed`, { error: r.email.error }) }
				: {
						ok: false,
						text: t(`${K}.email.${r.email.reason === 'no_sender' ? 'noSender' : 'noAddress'}`),
					};
	const inApp = r.inApp.isSwitchOn
		? { ok: true, text: t(`${K}.inApp.shown`) }
		: { ok: false, text: t(`${K}.inApp.off`) };
	const push =
		r.push.status === 'sent'
			? r.push.failed > 0
				? {
						ok: r.push.delivered > 0,
						text: t(`${K}.push.partial`, { delivered: r.push.delivered, failed: r.push.failed }),
					}
				: { ok: true, text: t(`${K}.push.delivered`, r.push.delivered) }
			: {
					ok: false,
					text: t(
						`${K}.push.${r.push.reason === 'not_configured' ? 'notConfigured' : r.push.reason === 'no_device' ? 'noDevice' : 'switchedOff'}`
					),
				};
	let webhook: { ok: boolean | null; text: string };
	if (r.webhook.status === 'skipped') {
		webhook = {
			ok: false,
			text: t(`${K}.webhook.${r.webhook.reason === 'not_set' ? 'notSet' : 'off'}`),
		};
	} else {
		const o = webhookOutcome.value;
		if (!o || o.pending > 0)
			webhook = { ok: null, text: t(`${K}.webhook.sending`, r.webhook.logIds.length) };
		else if (o.failed > 0) webhook = { ok: false, text: t(`${K}.webhook.failed`, o.failed) };
		else webhook = { ok: true, text: t(`${K}.webhook.delivered`, o.delivered) };
	}
	return [
		{ key: 'email', label: t(`${K}.labels.email`), ...email },
		{ key: 'inApp', label: t(`${K}.labels.inApp`), ...inApp },
		{ key: 'push', label: t(`${K}.labels.push`), ...push },
		{ key: 'webhook', label: t(`${K}.labels.webhook`), ...webhook },
	];
});
</script>

<template>
	<div class="space-y-3 px-5 py-4 sm:px-6">
		<div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
			<p class="text-xs text-text-tertiary">{{ t(`${K}.hint`) }}</p>
			<UiButton
				size="sm"
				variant="secondary"
				class="shrink-0 whitespace-nowrap"
				:loading="isSending"
				data-testid="alert-test-send"
				@click="runTest"
			>
				{{ t(`${K}.send`) }}
			</UiButton>
		</div>
		<dl
			v-if="lines.length"
			class="space-y-1 text-sm"
			aria-live="polite"
			data-testid="alert-test-result"
		>
			<div v-for="line in lines" :key="line.key" class="flex gap-2">
				<dt class="w-44 shrink-0 text-text-secondary">{{ line.label }}</dt>
				<dd
					:data-testid="`alert-test-${line.key}`"
					:class="
						line.ok === null ? 'text-text-tertiary' : line.ok ? 'text-success' : 'text-warning'
					"
				>
					{{ line.text }}
				</dd>
			</div>
		</dl>
	</div>
</template>
