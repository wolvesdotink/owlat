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

/** One provider's irreducibly specific instructions. */
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
const PROVIDER_COPY: Readonly<Record<string, ProviderWebhookCopy>> = {
	mandrill: {
		events: [
			{ name: 'send', why: 'confirms Mandrill accepted the message' },
			{ name: 'deferral', why: 'a receiver asked Mandrill to try later' },
			{ name: 'hard_bounce', why: 'suppresses the address and feeds the bounce gate' },
			{ name: 'soft_bounce', why: 'counts toward the arm’s deferral picture' },
			{ name: 'spam', why: 'suppresses the address and feeds the complaint gate' },
			{ name: 'unsub', why: 'records the unsubscribe against this arm' },
			{ name: 'reject', why: 'mirrors Mandrill’s own blacklist into your suppression list' },
		],
		urlNote:
			'Mandrill checks the URL before saving the webhook, and signs every later delivery over this exact string — a redirect or a trailing-slash difference fails the signature.',
		keyIssuance: 'Mandrill shows this key once, after the webhook is created',
	},
};

const providerCopy = computed<ProviderWebhookCopy>(() => PROVIDER_COPY[props.providerKind] ?? {});

const hasUrl = computed(() => props.webhookUrl !== '');
const urlNote = computed(
	() =>
		providerCopy.value.urlNote ??
		`${props.providerLabel} signs every delivery over this exact string — a redirect or a trailing-slash difference fails the signature.`
);
const keyIssuance = computed(
	() =>
		providerCopy.value.keyIssuance ??
		`${props.providerLabel} issues this key when the webhook is created`
);
const lastEventLabel = computed(() =>
	props.lastEventAt === null ? null : new Date(props.lastEventAt).toLocaleString()
);
</script>

<template>
	<UiCard padding="none" overflow="hidden" data-testid="signed-webhook-card">
		<template #header>
			<div class="flex items-center gap-3">
				<UiIconBox icon="lucide:radio" size="sm" variant="surface" rounded="lg" />
				<div>
					<h2 class="text-lg font-semibold text-text-primary" data-testid="signed-webhook-title">
						{{ providerLabel }} feedback webhook
					</h2>
					<p class="text-sm text-text-secondary">
						Let {{ providerLabel }} tell Owlat when mail bounces, is marked as spam, or is rejected —
						so those addresses are suppressed and the ramp can see this arm's real behaviour
					</p>
				</div>
			</div>
		</template>

		<div class="p-6 space-y-5">
			<!-- Endpoint -->
			<div v-if="hasUrl">
				<div class="flex items-center justify-between mb-2">
					<p class="text-xs font-medium text-text-primary">Webhook URL</p>
					<UiButton
						variant="ghost"
						size="sm"
						:title="isCopied('signed-webhook-url') ? 'Copied' : 'Copy webhook URL'"
						@click="copy(webhookUrl, 'signed-webhook-url')"
					>
						<Icon
							:name="isCopied('signed-webhook-url') ? 'lucide:check' : 'lucide:copy'"
							class="w-3.5 h-3.5"
							:class="isCopied('signed-webhook-url') ? 'text-success' : ''"
						/>
						{{ isCopied('signed-webhook-url') ? 'Copied' : 'Copy' }}
					</UiButton>
				</div>
				<pre
					class="select-all overflow-x-auto rounded-lg bg-bg-surface px-3 py-2 font-mono text-xs text-text-primary"
					data-testid="signed-webhook-url"
					>{{ webhookUrl }}</pre
				>
				<p class="text-xs text-text-tertiary mt-1.5" data-testid="signed-webhook-url-note">
					Create a webhook in your {{ providerLabel }} console pointing at this URL.
					{{ urlNote }}
				</p>
			</div>
			<p v-else class="text-xs text-text-tertiary" data-testid="signed-webhook-no-url">
				Set your site URL to see the endpoint {{ providerLabel }} should post to.
			</p>

			<!-- Events -->
			<div>
				<template v-if="providerCopy.events">
					<p class="text-sm font-medium text-text-primary mb-2">Enable exactly these events</p>
					<ul class="space-y-1.5" data-testid="signed-webhook-events">
						<li
							v-for="event in providerCopy.events"
							:key="event.name"
							class="flex items-start gap-2 text-xs text-text-secondary"
						>
							<Icon name="lucide:check" class="w-3.5 h-3.5 text-success mt-0.5 shrink-0" />
							<span
								><code class="text-text-primary">{{ event.name }}</code> — {{ event.why }}</span
							>
						</li>
					</ul>
				</template>
				<p v-else class="text-sm text-text-secondary" data-testid="signed-webhook-events-generic">
					Enable the delivery, bounce, complaint, unsubscribe and rejection events
					{{ providerLabel }} offers. Owlat records the ones it understands — suppressing the
					addresses behind bounces and complaints — and ignores the rest.
				</p>
				<p class="text-xs text-text-tertiary mt-3" data-testid="signed-webhook-tracking-events-off">
					Leave <code class="text-text-primary">open</code> and
					<code class="text-text-primary">click</code> tracking switched OFF. Owlat tracks opens and
					clicks first-party, identically on every transport, so the engagement gate compares the two
					arms on the same instrument.
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
							{{ keyIssuance }} — copy it into your environment and restart. Until it is set, Owlat
							rejects every posted batch rather than trusting an unsigned one.
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
						{{ isWebhookKeyPresent ? 'present' : 'missing' }}
					</span>
				</div>
			</div>

			<!-- Live "last event received" line -->
			<div class="flex items-center gap-2 text-xs" data-testid="signed-webhook-last-event">
				<template v-if="lastEventLabel">
					<Icon name="lucide:check-circle-2" class="w-3.5 h-3.5 text-success" />
					<span class="text-success">Last event received: {{ lastEventLabel }}</span>
				</template>
				<template v-else>
					<Icon name="lucide:clock" class="w-3.5 h-3.5 text-text-tertiary" />
					<span class="text-text-tertiary">
						No feedback received yet. Once the webhook is saved and a message bounces, is marked as
						spam, or is rejected, it appears here.
					</span>
				</template>
			</div>
		</div>
	</UiCard>
</template>
