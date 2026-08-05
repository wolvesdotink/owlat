<script setup lang="ts">
/**
 * Wiring Mandrill's feedback back to this deployment — the Mandrill twin of the
 * SES SNS block on the same page.
 *
 * Three things an operator cannot guess and must not have to: the exact endpoint
 * URL, WHICH events to enable, and where the signing key comes from. The event
 * list is opinionated and the omissions are the point — `open` and `click` are
 * deliberately off, because Owlat's own pixel and redirects instrument BOTH arms
 * identically and the engagement ramp gate compares them against each other. A
 * provider's own open counts would make the reference arm look different for a
 * reason that has nothing to do with deliverability.
 *
 * Presentational: the URL and the presence booleans are props, so the copy is
 * testable without a backend. No credential value ever reaches this component —
 * `MANDRILL_WEBHOOK_KEY` is rendered as a NAME and a present/missing chip.
 */

const props = defineProps<{
	/**
	 * Absolute HTTPS endpoint Mandrill posts to, or `''` when the site URL is
	 * unknown — never a relative path, which Mandrill cannot subscribe to.
	 */
	webhookUrl: string;
	/** Presence only, from `getMandrillFeedbackStatus`. Never a value. */
	isWebhookKeyPresent: boolean;
	/** When the last signed batch arrived, or null if none ever has. */
	lastEventAt: number | null;
}>();

const { copy, isCopied } = useCopyToClipboard();

/** The events Owlat consumes. Anything not listed here it ignores on arrival. */
const WEBHOOK_EVENTS = [
	{ name: 'send', why: 'confirms Mandrill accepted the message' },
	{ name: 'deferral', why: 'a receiver asked Mandrill to try later' },
	{ name: 'hard_bounce', why: 'suppresses the address and feeds the bounce gate' },
	{ name: 'soft_bounce', why: 'counts toward the arm’s deferral picture' },
	{ name: 'spam', why: 'suppresses the address and feeds the complaint gate' },
	{ name: 'unsub', why: 'records the unsubscribe against this arm' },
	{ name: 'reject', why: 'mirrors Mandrill’s own blacklist into your suppression list' },
] as const;

const hasUrl = computed(() => props.webhookUrl !== '');
const lastEventLabel = computed(() =>
	props.lastEventAt === null ? null : new Date(props.lastEventAt).toLocaleString()
);
</script>

<template>
	<UiCard padding="none" overflow="hidden" data-testid="mandrill-webhook-card">
		<template #header>
			<div class="flex items-center gap-3">
				<UiIconBox icon="lucide:radio" size="sm" variant="surface" rounded="lg" />
				<div>
					<h2 class="text-lg font-semibold text-text-primary">
						Mailchimp Transactional feedback webhook
					</h2>
					<p class="text-sm text-text-secondary">
						Let Mandrill tell Owlat when mail bounces, is marked as spam, or hits its reject list —
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
					<button
						type="button"
						class="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-surface hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
						:title="isCopied('mandrill-url') ? 'Copied' : 'Copy webhook URL'"
						@click="copy(webhookUrl, 'mandrill-url')"
					>
						<Icon
							:name="isCopied('mandrill-url') ? 'lucide:check' : 'lucide:copy'"
							class="w-3.5 h-3.5"
							:class="isCopied('mandrill-url') ? 'text-success' : ''"
						/>
						{{ isCopied('mandrill-url') ? 'Copied' : 'Copy' }}
					</button>
				</div>
				<pre
					class="select-all overflow-x-auto rounded-lg bg-bg-surface px-3 py-2 font-mono text-xs text-text-primary"
					data-testid="mandrill-webhook-url"
					>{{ webhookUrl }}</pre
				>
				<p class="text-xs text-text-tertiary mt-1.5">
					Mandrill checks the URL before saving the webhook, and signs every later delivery over
					this exact string — a redirect or a trailing-slash difference fails the signature.
				</p>
			</div>
			<p v-else class="text-xs text-text-tertiary" data-testid="mandrill-webhook-no-url">
				Set your site URL to see the endpoint Mandrill should post to.
			</p>

			<!-- Events -->
			<div>
				<p class="text-sm font-medium text-text-primary mb-2">Enable exactly these events</p>
				<ul class="space-y-1.5">
					<li
						v-for="event in WEBHOOK_EVENTS"
						:key="event.name"
						class="flex items-start gap-2 text-xs text-text-secondary"
					>
						<Icon name="lucide:check" class="w-3.5 h-3.5 text-success mt-0.5 shrink-0" />
						<span><code class="text-text-primary">{{ event.name }}</code> — {{ event.why }}</span>
					</li>
				</ul>
				<p class="text-xs text-text-tertiary mt-3" data-testid="mandrill-tracking-events-off">
					Leave <code class="text-text-primary">open</code> and
					<code class="text-text-primary">click</code> switched OFF. Owlat tracks opens and clicks
					first-party, identically on every transport, so the engagement gate compares the two arms
					on the same instrument.
				</p>
			</div>

			<!-- Signing key -->
			<div class="border-t border-border-subtle pt-5">
				<div class="flex items-center justify-between gap-3">
					<div class="min-w-0">
						<p class="text-sm font-medium text-text-primary">
							<code>MANDRILL_WEBHOOK_KEY</code>
						</p>
						<p class="text-xs text-text-tertiary mt-0.5">
							Mandrill shows this key once, after the webhook is created — copy it into your
							environment and restart. Until it is set, Owlat rejects every posted batch rather
							than trusting an unsigned one.
						</p>
					</div>
					<span
						class="inline-flex items-center gap-1.5 text-xs font-medium shrink-0"
						:class="isWebhookKeyPresent ? 'text-success' : 'text-warning'"
						data-testid="mandrill-webhook-key-presence"
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
			<div class="flex items-center gap-2 text-xs" data-testid="mandrill-last-event">
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
