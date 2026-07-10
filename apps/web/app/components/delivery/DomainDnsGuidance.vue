<script setup lang="ts">
/**
 * Per-transport DNS guidance for the sending-domains page.
 *
 * How you make a domain "yours" for sending depends on the transport: Owlat’s
 * mail server publishes managed records, SES signs with its own DKIM identity
 * tokens, and an SMTP relay does SPF/DKIM on your behalf. This collapsed note
 * tells the operator, in plain language, what to check for the transport that’s
 * actually live — no new DNS machinery, just the right pointer. Reads the
 * member-safe `getTransportSummary` for the active kind.
 */
import { api } from '@owlat/api';

const { data: summary } = useOrganizationQuery(api.delivery.status.getTransportSummary);

interface Guidance {
	label: string;
	lead: string;
	points: string[];
}

// Copy keyed by transport kind. Static, plain-language, deliberately no DNS
// generation — the records themselves live in the table below (MTA) or in the
// provider’s own console (SES / SMTP / Resend).
const GUIDANCE: Record<string, Guidance> = {
	mta: {
		label: 'Owlat mail server',
		lead: 'Owlat manages the DNS for you.',
		points: [
			'The SPF, DKIM, and DMARC records shown for each domain below are the managed records — add them exactly as displayed, then verify.',
			'Once verified, Owlat signs your mail as your domain automatically.',
		],
	},
	ses: {
		label: 'Amazon SES',
		lead: 'SES signs your mail with its own DKIM identity tokens.',
		points: [
			'In the SES console, open Verified identities → your domain → and add the three DKIM CNAME records SES generates for the identity.',
			'Keep an SPF record that authorizes SES (include amazonses.com) and a DMARC record so receivers can check alignment.',
		],
	},
	smtp: {
		label: 'SMTP relay',
		lead: 'Your relay provider handles SPF and DKIM for you.',
		points: [
			'Follow your provider’s setup guide to add their SPF include and DKIM records for this domain.',
			'Then confirm two things: your domain’s SPF authorizes the relay, and mail from the relay carries a DKIM signature that validates for your domain.',
		],
	},
	resend: {
		label: 'Resend',
		lead: 'Resend signs your mail once your domain is verified there.',
		points: [
			'In the Resend dashboard, add the SPF and DKIM records it shows for this domain.',
			'A DMARC record on top lets receivers check that SPF or DKIM aligns with your domain.',
		],
	},
};

const guidance = computed<Guidance | null>(() => {
	const kind = summary.value?.provider;
	if (!kind) return null;
	return GUIDANCE[kind] ?? null;
});

const open = ref(false);
</script>

<template>
	<UiCard v-if="guidance" padding="none" overflow="hidden" class="mb-6">
		<button
			type="button"
			class="w-full flex items-center justify-between gap-3 px-4 py-3 text-left transition-colors duration-(--motion-fast) hover:bg-bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
			:aria-expanded="open"
			@click="open = !open"
		>
			<span class="flex items-center gap-2.5 min-w-0">
				<Icon name="lucide:shield-check" class="w-4 h-4 text-text-tertiary shrink-0" />
				<span class="text-sm text-text-secondary truncate">
					<span class="font-medium text-text-primary">DNS for {{ guidance.label }}</span> —
					{{ guidance.lead }}
				</span>
			</span>
			<Icon
				name="lucide:chevron-down"
				class="w-4 h-4 text-text-tertiary shrink-0 transition-transform duration-(--motion-fast)"
				:class="open ? 'rotate-180' : ''"
			/>
		</button>
		<div v-if="open" class="px-4 pb-4 pt-1 border-t border-border-subtle">
			<ul class="mt-3 space-y-2">
				<li
					v-for="(point, i) in guidance.points"
					:key="i"
					class="flex items-start gap-2 text-sm text-text-secondary"
				>
					<Icon name="lucide:check" class="w-4 h-4 text-success mt-0.5 shrink-0" />
					<span>{{ point }}</span>
				</li>
			</ul>
		</div>
	</UiCard>
</template>
