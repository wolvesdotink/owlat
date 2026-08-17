<script setup lang="ts">
/**
 * The `signed-webhook` feedback ceremony, for WHICHEVER provider declares it —
 * the twin of the SES SNS block on the same page.
 *
 * Three things an operator cannot guess and must not have to: the exact endpoint
 * URL, WHICH events to enable, and where the signing key comes from. All three
 * are now VENDOR DATA rather than vendor prose: the URL, the provider's name and
 * the signing-key VARIABLE NAME arrive as props derived from the active kind's
 * catalog entry. This card used to be Mandrill's alone and hardcoded Mandrill's
 * title, Mandrill's events and `MANDRILL_WEBHOOK_KEY`; the moment a second kind
 * declared the same panel, its operator was told to set the wrong variable and
 * watched a "missing" chip that could never clear.
 *
 * Genuinely vendor-specific detail — Mandrill's event list, and its "the key is
 * shown once" caveat — lives in {@link PROVIDER_COPY}, keyed by kind and
 * colocated with the markup it feeds. A kind with no entry there gets the
 * generic ceremony, which is correct for any console webhook.
 *
 * Presentational: every fact is a prop, so the copy is testable without a
 * backend. No credential value ever reaches this component — the signing key is
 * rendered as a NAME and a present/missing chip.
 */

const props = defineProps<{
	/**
	 * The active transport kind, used ONLY to look up the per-kind copy below.
	 * Nothing that must be right for an unknown kind may key off it.
	 */
	providerKind: string;
	/** The operator's name for that provider, e.g. 'Mailchimp Transactional'. */
	providerLabel: string;
	/**
	 * NAME of the deployment variable holding the key the endpoint verifies
	 * signatures with, from the kind's catalog entry. Never a value.
	 */
	signingKeyEnvVar: string;
	/**
	 * Absolute HTTPS endpoint the provider posts to, or `''` when the site URL is
	 * unknown — never a relative path, which no console can subscribe to.
	 */
	webhookUrl: string;
	/** Presence only, from `getProviderFeedbackStatus`. Never a value. */
	isWebhookKeyPresent: boolean;
	/** When the last signed batch arrived, or null if none ever has. */
	lastEventAt: number | null;
}>();

const { copy, isCopied } = useCopyToClipboard();

const { t, locale } = useI18n();

/**
 * One provider's irreducibly specific instructions.
 *
 * Every field below is an i18n KEY rather than a sentence — the table is
 * module-scope data, so it may not call `t` itself; the markup that renders a
 * value resolves it. The event NAMES are not copy: they are the literal strings
 * the provider's console shows, and translating them would name a checkbox that
 * does not exist.
 */
interface ProviderWebhookCopy {
	/** The events Owlat consumes, when the console asks the operator to pick. */
	readonly events?: readonly { readonly name: string; readonly why: string }[];
	/** Anything about the URL beyond "it is signed over verbatim". */
	readonly urlNote?: string;
	/**
	 * How this provider hands the key over, as a clause the generic sentence
	 * continues with "— copy it into your environment and restart".
	 */
	readonly keyIssuance?: string;
}

/**
 * PER-KIND copy, and only what is genuinely per-kind.
 *
 * The event list is opinionated and the omissions are the point — `open` and
 * `click` are deliberately absent, because Owlat's own pixel and redirects
 * instrument BOTH arms identically and the engagement ramp gate compares them
 * against each other. A provider's own open counts would make the reference arm
 * look different for a reason that has nothing to do with deliverability.
 */
const MANDRILL_EVENT_COPY = 'components.delivery.signedWebhookCard.mandrill.events';

const PROVIDER_COPY: Readonly<Record<string, ProviderWebhookCopy>> = {
	mandrill: {
		events: [
			{ name: 'send', why: `${MANDRILL_EVENT_COPY}.send` },
			{ name: 'deferral', why: `${MANDRILL_EVENT_COPY}.deferral` },
			{ name: 'hard_bounce', why: `${MANDRILL_EVENT_COPY}.hardBounce` },
			{ name: 'soft_bounce', why: `${MANDRILL_EVENT_COPY}.softBounce` },
			{ name: 'spam', why: `${MANDRILL_EVENT_COPY}.spam` },
			{ name: 'unsub', why: `${MANDRILL_EVENT_COPY}.unsub` },
			{ name: 'reject', why: `${MANDRILL_EVENT_COPY}.reject` },
		],
		urlNote: 'components.delivery.signedWebhookCard.mandrill.urlNote',
		keyIssuance: 'components.delivery.signedWebhookCard.mandrill.keyIssuance',
	},
};

const providerCopy = computed<ProviderWebhookCopy>(() => PROVIDER_COPY[props.providerKind] ?? {});

const hasUrl = computed(() => props.webhookUrl !== '');
const urlNote = computed(() => {
	const key = providerCopy.value.urlNote;
	return key === undefined
		? t('components.delivery.signedWebhookCard.urlNoteGeneric', { provider: props.providerLabel })
		: t(key);
});
const keyIssuance = computed(() => {
	const key = providerCopy.value.keyIssuance;
	return key === undefined
		? t('components.delivery.signedWebhookCard.keyIssuanceGeneric', {
				provider: props.providerLabel,
			})
		: t(key);
});
const lastEventLabel = computed(() =>
	props.lastEventAt === null ? null : new Date(props.lastEventAt).toLocaleString(locale.value)
);
</script>

<template>
	<UiCard padding="none" overflow="hidden" data-testid="signed-webhook-card">
		<template #header>
			<div class="flex items-center gap-3">
				<UiIconBox icon="lucide:radio" size="sm" variant="surface" rounded="lg" />
				<div>
					<h2 class="text-lg font-semibold text-text-primary" data-testid="signed-webhook-title">
						{{ t('components.delivery.signedWebhookCard.title', { provider: providerLabel }) }}
					</h2>
					<p class="text-sm text-text-secondary">
						{{ t('components.delivery.signedWebhookCard.subtitle', { provider: providerLabel }) }}
					</p>
				</div>
			</div>
		</template>

		<div class="p-6 space-y-5">
			<!-- Endpoint -->
			<div v-if="hasUrl">
				<div class="flex items-center justify-between mb-2">
					<p class="text-xs font-medium text-text-primary">
						{{ t('components.delivery.signedWebhookCard.webhookUrl') }}
					</p>
					<UiButton
						variant="ghost"
						size="sm"
						:title="
							isCopied('signed-webhook-url')
								? t('common.copied')
								: t('components.delivery.signedWebhookCard.copyWebhookUrl')
						"
						@click="copy(webhookUrl, 'signed-webhook-url')"
					>
						<Icon
							:name="isCopied('signed-webhook-url') ? 'lucide:check' : 'lucide:copy'"
							class="w-3.5 h-3.5"
							:class="isCopied('signed-webhook-url') ? 'text-success' : ''"
						/>
						{{ isCopied('signed-webhook-url') ? t('common.copied') : t('common.copy') }}
					</UiButton>
				</div>
				<pre
					class="select-all overflow-x-auto rounded-lg bg-bg-surface px-3 py-2 font-mono text-xs text-text-primary"
					data-testid="signed-webhook-url"
					>{{ webhookUrl }}</pre
				>
				<p class="text-xs text-text-tertiary mt-1.5" data-testid="signed-webhook-url-note">
					{{
						t('components.delivery.signedWebhookCard.createWebhook', { provider: providerLabel })
					}}
					{{ urlNote }}
				</p>
			</div>
			<p v-else class="text-xs text-text-tertiary" data-testid="signed-webhook-no-url">
				{{ t('components.delivery.signedWebhookCard.noUrl', { provider: providerLabel }) }}
			</p>

			<!-- Events -->
			<div>
				<template v-if="providerCopy.events">
					<p class="text-sm font-medium text-text-primary mb-2">
						{{ t('components.delivery.signedWebhookCard.enableEvents') }}
					</p>
					<ul class="space-y-1.5" data-testid="signed-webhook-events">
						<li
							v-for="event in providerCopy.events"
							:key="event.name"
							class="flex items-start gap-2 text-xs text-text-secondary"
						>
							<Icon name="lucide:check" class="w-3.5 h-3.5 text-success mt-0.5 shrink-0" />
							<span
								><code class="text-text-primary">{{ event.name }}</code> — {{ t(event.why) }}</span
							>
						</li>
					</ul>
				</template>
				<p v-else class="text-sm text-text-secondary" data-testid="signed-webhook-events-generic">
					{{ t('components.delivery.signedWebhookCard.eventsGeneric', { provider: providerLabel }) }}
				</p>
				<p class="text-xs text-text-tertiary mt-3" data-testid="signed-webhook-tracking-events-off">
					<I18nT
						keypath="components.delivery.signedWebhookCard.trackingEventsOff"
						tag="span"
						scope="global"
					>
						<template #open><code class="text-text-primary">open</code></template>
						<template #click><code class="text-text-primary">click</code></template>
					</I18nT>
				</p>
			</div>

			<!-- Signing key -->
			<div v-if="signingKeyEnvVar" class="border-t border-border-subtle pt-5">
				<div class="flex items-center justify-between gap-3">
					<div class="min-w-0">
						<p class="text-sm font-medium text-text-primary">
							<code>{{ signingKeyEnvVar }}</code>
						</p>
						<p class="text-xs text-text-tertiary mt-0.5" data-testid="signed-webhook-key-note">
							{{
								t('components.delivery.signedWebhookCard.keyNote', { issuance: keyIssuance })
							}}
						</p>
					</div>
					<span
						class="inline-flex items-center gap-1.5 text-xs font-medium shrink-0"
						:class="isWebhookKeyPresent ? 'text-success' : 'text-warning'"
						data-testid="signed-webhook-key-presence"
					>
						<Icon
							:name="isWebhookKeyPresent ? 'lucide:check' : 'lucide:alert-triangle'"
							class="w-3.5 h-3.5"
						/>
						{{
							isWebhookKeyPresent
								? t('components.delivery.signedWebhookCard.keyPresent')
								: t('components.delivery.signedWebhookCard.keyMissing')
						}}
					</span>
				</div>
			</div>

			<!-- Live "last event received" line -->
			<div class="flex items-center gap-2 text-xs" data-testid="signed-webhook-last-event">
				<template v-if="lastEventLabel">
					<Icon name="lucide:check-circle-2" class="w-3.5 h-3.5 text-success" />
					<span class="text-success">
						{{ t('components.delivery.signedWebhookCard.lastEvent', { at: lastEventLabel }) }}
					</span>
				</template>
				<template v-else>
					<Icon name="lucide:clock" class="w-3.5 h-3.5 text-text-tertiary" />
					<span class="text-text-tertiary">
						{{ t('components.delivery.signedWebhookCard.noFeedback') }}
					</span>
				</template>
			</div>
		</div>
	</UiCard>
</template>
