<script setup lang="ts">
/**
 * The `sns-topic` feedback ceremony, for WHICHEVER provider declares it — the
 * twin of {@link SignedWebhookCard} on the same page.
 *
 * Bounces and complaints arrive through a topic the operator subscribes to, so
 * the two things they cannot guess are the exact endpoint the topic posts to and
 * WHICH deployment variables carry the topic/configuration-set names. Both are
 * rendered here: the URL as a prop derived from the active kind's catalog entry,
 * the variable NAMES as literals inside the numbered steps.
 *
 * Presentational: every fact is a prop, so nothing about the ceremony needs a
 * backend to render, and no credential value ever reaches this component — the
 * last-event line is a timestamp, never an event body.
 */
const props = defineProps<{
	/**
	 * Absolute HTTPS endpoint the topic delivers to, or `''` when the site URL is
	 * unknown — never a relative path, which an SNS subscription cannot use.
	 */
	webhookUrl: string;
	/** When the last event arrived, or null if none ever has. */
	lastEventAt: number | null;
}>();

const { t, locale } = useI18n();
const { copy, isCopied } = useCopyToClipboard();

const lastEventLabel = computed(() => {
	const at = props.lastEventAt;
	if (!at) return null;
	return new Intl.DateTimeFormat(locale.value, {
		dateStyle: 'medium',
		timeStyle: 'medium',
	}).format(new Date(at));
});
</script>

<template>
	<UiCard padding="none" overflow="hidden">
		<template #header>
			<div class="flex items-center gap-3">
				<UiIconBox icon="lucide:radio" size="sm" variant="surface" rounded="lg" />
				<div>
					<h2 class="text-lg font-semibold text-text-primary">
						{{ t('dashboard.admin.delivery.transport.sns.title') }}
					</h2>
					<p class="text-sm text-text-secondary">
						{{ t('dashboard.admin.delivery.transport.sns.subtitle') }}
					</p>
				</div>
			</div>
		</template>

		<div class="p-6 space-y-5">
			<p class="text-sm text-text-secondary">
				{{ t('dashboard.admin.delivery.transport.sns.intro') }}
			</p>

			<!-- Webhook endpoint -->
			<div v-if="webhookUrl">
				<div class="flex items-center justify-between mb-2">
					<p class="text-xs font-medium text-text-primary">
						{{ t('dashboard.admin.delivery.transport.sns.endpointTitle') }}
					</p>
					<UiButton
						variant="ghost"
						size="sm"
						:title="
							isCopied('ses-url')
								? t('common.copied')
								: t('dashboard.admin.delivery.transport.sns.copyEndpoint')
						"
						@click="copy(webhookUrl, 'ses-url')"
					>
						<Icon
							:name="isCopied('ses-url') ? 'lucide:check' : 'lucide:copy'"
							class="w-3.5 h-3.5"
							:class="isCopied('ses-url') ? 'text-success' : ''"
						/>
						{{ isCopied('ses-url') ? t('common.copied') : t('common.copy') }}
					</UiButton>
				</div>
				<pre
					class="select-all overflow-x-auto rounded-lg bg-bg-surface px-3 py-2 font-mono text-xs text-text-primary"
					>{{ webhookUrl }}</pre>
			</div>
			<p v-else class="text-xs text-text-tertiary">
				{{ t('dashboard.admin.delivery.transport.sns.noSiteUrl') }}
			</p>

			<!-- Setup steps -->
			<ol class="space-y-2 text-sm text-text-secondary list-decimal pl-5">
				<I18nT keypath="dashboard.admin.delivery.transport.sns.step1" tag="li" scope="global">
					<template #topic><code class="text-text-primary">owlat-ses-feedback</code></template>
					<template #https><span class="text-text-primary">HTTPS</span></template>
				</I18nT>
				<I18nT keypath="dashboard.admin.delivery.transport.sns.step2" tag="li" scope="global">
					<template #envVar>
						<code class="text-text-primary">SES_SNS_TOPIC_ARN</code>
					</template>
				</I18nT>
				<I18nT keypath="dashboard.admin.delivery.transport.sns.step3" tag="li" scope="global">
					<template #configurationSet>
						<span class="text-text-primary">Configuration Set</span>
					</template>
					<template #bounce><code class="text-text-primary">Bounce</code></template>
					<template #complaint><code class="text-text-primary">Complaint</code></template>
					<template #delivery><code class="text-text-primary">Delivery</code></template>
				</I18nT>
				<I18nT keypath="dashboard.admin.delivery.transport.sns.step4" tag="li" scope="global">
					<template #envVar>
						<code class="text-text-primary">SES_CONFIGURATION_SET</code>
					</template>
				</I18nT>
			</ol>

			<!-- Live "last event received" line -->
			<div class="flex items-center gap-2 text-xs">
				<template v-if="lastEventLabel">
					<Icon name="lucide:check-circle-2" class="w-3.5 h-3.5 text-success" />
					<span class="text-success">{{
						t('dashboard.admin.delivery.transport.sns.lastEvent', { at: lastEventLabel })
					}}</span>
				</template>
				<template v-else>
					<Icon name="lucide:clock" class="w-3.5 h-3.5 text-text-tertiary" />
					<span class="text-text-tertiary">
						{{ t('dashboard.admin.delivery.transport.sns.noEvents') }}
					</span>
				</template>
			</div>
		</div>
	</UiCard>
</template>
