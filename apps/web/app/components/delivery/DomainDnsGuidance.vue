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
import { type DeliveryProviderKind, isDeliveryProviderKind } from '@owlat/shared';
import { coreSendProviderCatalogEntry } from '@owlat/shared/sendProviderCatalog';
import { api } from '@owlat/api';
import { TRANSPORT_LABEL } from '~/utils/transportState';

const { data: summary } = useOrganizationQuery(api.delivery.status.getTransportSummary);

interface Guidance {
	lead: string;
	points: string[];
}

/**
 * WHAT A TRANSPORT WITHOUT ITS OWN PARAGRAPH SAYS — derived from the catalog's
 * `domainVerification` capability (the seams plan's D5), because that capability
 * IS the answer to "how does this domain become mine for sending?".
 *
 * `api` means the provider has an identity API we (or the operator) register the
 * domain with, so the ownership step is real and separate from the DNS.
 * `none` means the transport publishes nothing about the domain and the records
 * are the provider's own to document.
 *
 * A new provider therefore renders honest guidance the day it is declared,
 * instead of the blank card (or the compile error) a per-kind table produced.
 * The five paragraphs below are OVERRIDES — the copy each incumbent earned,
 * kept verbatim — not the mechanism.
 */
const CAPABILITY_GUIDANCE: Record<'api' | 'none', Guidance> = {
	api: {
		lead: 'Your provider verifies this domain through its own identity API.',
		points: [
			'Publish the SPF and DKIM records your provider shows for this domain, exactly as displayed.',
			'Then complete the provider’s own domain verification. Until that clears, it can reject mail from this domain no matter how good the DNS is.',
			'Keep a DMARC record on the domain so receivers can check that SPF or DKIM aligns; your existing policy stays authoritative.',
		],
	},
	none: {
		lead: 'Your provider handles SPF and DKIM for you.',
		points: [
			'Follow your provider’s setup guide to add their SPF include and DKIM records for this domain.',
			'Then confirm two things: your domain’s SPF authorizes the provider, and mail from it carries a DKIM signature that validates for your domain.',
		],
	},
};

// Copy keyed by transport kind. Static, plain-language, deliberately no DNS
// generation — the records themselves live in the table below (MTA) or in the
// provider’s own console (SES / SMTP / Resend). Each entry OVERRIDES the
// capability-derived paragraph above with the wording that transport earned; a
// kind with no entry falls back to its capability rather than to nothing.
const GUIDANCE: Partial<Record<DeliveryProviderKind, Guidance>> = {
	mta: {
		lead: 'Owlat manages the DNS for you.',
		points: [
			'The SPF, DKIM, and DMARC records shown for each domain below are the managed records — add them exactly as displayed, then verify.',
			'Once verified, Owlat signs your mail as your domain automatically.',
		],
	},
	ses: {
		lead: 'SES signs your mail with its own DKIM identity tokens.',
		points: [
			'In the SES console, open Verified identities → your domain → and add the three DKIM CNAME records SES generates for the identity.',
			'Keep an SPF record that authorizes SES (include amazonses.com) and a DMARC record so receivers can check alignment.',
		],
	},
	smtp: {
		lead: 'Your relay provider handles SPF and DKIM for you.',
		points: [
			'Follow your provider’s setup guide to add their SPF include and DKIM records for this domain.',
			'Then confirm two things: your domain’s SPF authorizes the relay, and mail from the relay carries a DKIM signature that validates for your domain.',
		],
	},
	resend: {
		lead: 'Resend signs your mail once your domain is verified there.',
		points: [
			'In the Resend dashboard, add the SPF and DKIM records it shows for this domain.',
			'A DMARC record on top lets receivers check that SPF or DKIM aligns with your domain.',
		],
	},
	// Three items, not two — and the third is the one that surprises people. A
	// domain with flawless SPF and DKIM but no completed ownership check is one
	// Mandrill still rejects (`unsigned`). The EXACT records are derived from the
	// domain name and rendered right below this card by the Mandrill status
	// panel, which is why this entry points at them instead of restating a DKIM
	// key that would immediately be a second copy.
	mandrill: {
		lead: 'Mailchimp Transactional signs with one shared key, so your records are the same every time.',
		points: [
			'Publish the two records shown under “Mailchimp Transactional sending domains” below: the SPF include that authorizes Mandrill’s IPs, and the DKIM TXT at mandrill._domainkey. They are derived from your domain name, so they are exactly what Owlat registered.',
			'Then complete Mandrill’s own domain verification — the TXT token shown beside the records, or the confirmation flow in Settings → Domains → Sending Domains. Until that clears, Mandrill rejects mail from this domain no matter how good the DNS is.',
			'Keep a DMARC record on the domain so receivers can check that SPF or DKIM aligns; your existing policy stays authoritative.',
		],
	},
};

const guidance = computed<{ label: string; lead: string; points: string[] } | null>(() => {
	const kind = summary.value?.provider ?? undefined;
	if (!isDeliveryProviderKind(kind)) return null;
	const entry = coreSendProviderCatalogEntry(kind);
	const derived = CAPABILITY_GUIDANCE[entry?.domainVerification ?? 'none'];
	return { label: TRANSPORT_LABEL[kind], ...(GUIDANCE[kind] ?? derived) };
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
