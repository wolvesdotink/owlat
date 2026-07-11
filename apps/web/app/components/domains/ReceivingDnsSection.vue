<script setup lang="ts">
/**
 * Inbound ("Receiving") DNS guidance for one sending domain — the inbound
 * mirror of the SPF/DKIM/DMARC/MAIL FROM panels. Shows the MX record the domain
 * must publish to receive mail through this deployment's MTA, plus the inbound
 * SMTP port + firewall note.
 *
 * The MX derivation is the pure `buildInboundMxRecords` helper (unit-tested);
 * the copyable host/value reuse the same `DomainsDNSRecordPanel` the sending
 * side uses. Renders nothing when there is no mail host to point at (send-only
 * install with no MTA).
 *
 * The section renders whether or not inbound is turned on, to break the
 * chicken-and-egg where an admin setting inbound up couldn't find the MX
 * instructions because they were hidden behind the very flag they were trying
 * to enable. When `inboundEnabled` is false we show an honest "receiving isn't
 * turned on yet — here's how" banner with the enable path (Settings → Features)
 * plus the MX record to add, and skip the live reverse-DNS preflight (there is
 * nothing to accept mail yet, so the port/PTR verdict would be misleading).
 *
 * Reverse DNS (PTR) used to be static "set reverse DNS" advice; it is now a live
 * FCrDNS preflight (`checkReceivingReverseDns`) run once against this
 * deployment's own mail host, surfaced as a green (confirmed) / amber (missing
 * or mismatched) line. The action is admin-gated and fail-soft — a DNS hiccup
 * resolves to "not confirmed" and never breaks the panel. Port-25 egress
 * reachability isn't testable from the backend, so that stays advisory text.
 */
import { api } from '@owlat/api';
import { buildInboundMxRecords } from '~/utils/inboundDns';

const props = defineProps<{
	/** The sending domain whose inbound MX records to derive. */
	domain: string;
	/** This deployment's mail host (MTA EHLO hostname), or null when unset. */
	mailHost: string | null | undefined;
	/** The inbound SMTP port other mail servers deliver to. */
	inboundPort: number;
	/**
	 * Whether an inbound feature is turned on for this deployment. When false the
	 * MX guidance still renders (so setup isn't a chicken-and-egg), but framed as
	 * a "not turned on yet — here's how" state and the reverse-DNS preflight is
	 * skipped.
	 */
	inboundEnabled: boolean;
}>();

const mxRecords = computed(() => buildInboundMxRecords(props.domain, props.mailHost));

// Live reverse-DNS (PTR / FCrDNS) preflight for the deployment's mail host. The
// backend reads the host authoritatively from env and never throws; `run()`
// surfaces the structured verdict (or undefined on the off chance it faults),
// so the panel simply omits the status line rather than erroring.
const { run: runReverseDnsCheck } = useBackendOperation(
	api.domains.dnsVerification.checkReceivingReverseDns,
	{ label: 'Check receiving reverse DNS', type: 'action' }
);

type ReverseDnsVerdict = Awaited<ReturnType<typeof runReverseDnsCheck>>;
const reverseDns = ref<ReverseDnsVerdict>(undefined);
const reverseDnsChecked = ref(false);

onMounted(async () => {
	// Only meaningful when there is a mail host to point at AND inbound is on;
	// with inbound off there is nothing accepting mail, so a PTR verdict would be
	// misleading. The parent gates on the mail host too — guard here so a
	// send-only or not-yet-enabled render is a no-op.
	if (!props.mailHost || !props.inboundEnabled) return;
	reverseDns.value = await runReverseDnsCheck({});
	reverseDnsChecked.value = true;
});
</script>

<template>
	<div v-if="mxRecords.length > 0" class="pt-2">
		<p class="text-xs font-medium text-text-tertiary uppercase tracking-wider mb-2">
			Receiving (inbound mail)
		</p>

		<!-- Honest "not turned on yet" state — receiving is off, but we still show
		     the enable path + MX record so setup isn't a chicken-and-egg. -->
		<div
			v-if="!inboundEnabled"
			data-testid="receiving-not-enabled"
			class="mb-3 p-4 bg-bg-surface rounded-xl border border-border-subtle"
		>
			<p class="text-sm text-text-secondary">
				<strong class="text-text-primary">Receiving isn't turned on yet.</strong>
				This deployment isn't set up to accept mail for your domains. You can add the MX record
				below now so DNS is ready — but incoming mail won't be accepted until you turn on a
				receiving feature.
			</p>
			<NuxtLink
				to="/dashboard/settings/features"
				class="inline-flex items-center gap-1 text-sm text-brand hover:underline mt-2"
			>
				Turn on receiving in Settings → Features
				<Icon name="lucide:arrow-right" class="w-3.5 h-3.5" />
			</NuxtLink>
		</div>

		<p class="text-sm text-text-secondary mb-3">
			To receive mail for <strong class="text-text-primary">{{ domain }}</strong> through this Owlat
			instance, publish the MX record below. Inbound mail is delivered to this deployment's mail
			host (<code class="bg-bg-surface px-1.5 py-0.5 rounded text-xs">{{ mailHost }}</code
			>).
		</p>

		<div class="space-y-3">
			<div v-for="(mx, i) in mxRecords" :key="`mx-${i}`">
				<p class="text-xs text-text-tertiary mb-1">
					Priority / preference:
					<code class="bg-bg-surface px-1.5 py-0.5 rounded">{{ mx.priority }}</code>
				</p>
				<DomainsDNSRecordPanel
					:record="{ type: mx.type, host: mx.host, value: mx.value }"
					label="MX"
					:domain="domain"
				/>
			</div>
		</div>

		<!-- Operational detail (firewall + live PTR verdict) only matters once
		     receiving is actually turned on. -->
		<div
			v-if="inboundEnabled"
			class="mt-4 p-4 bg-bg-surface rounded-xl border border-border-subtle"
		>
			<p class="text-sm text-text-secondary">
				<strong class="text-text-primary">Inbound port + firewall:</strong>
				other mail servers connect to
				<code class="bg-bg-deep px-1.5 py-0.5 rounded text-xs">{{ mailHost }}</code>
				on TCP port
				<code class="bg-bg-deep px-1.5 py-0.5 rounded text-xs">{{ inboundPort }}</code>
				to deliver mail, so open inbound TCP {{ inboundPort }} on your firewall / security group.
				Many cloud providers block port {{ inboundPort }} by default — confirm your host allows
				inbound SMTP.
			</p>

			<!-- Live reverse-DNS (PTR) verdict — replaces the old static advice. -->
			<p
				v-if="reverseDnsChecked && reverseDns && reverseDns.matchesHost"
				class="text-sm text-success mt-2"
			>
				Reverse DNS confirmed:
				<code class="bg-bg-deep px-1.5 py-0.5 rounded text-xs">{{ reverseDns.ptrValue }}</code>
				matches your mail host — receiving MTAs (Gmail/Yahoo) will forward-confirm this host.
			</p>
			<p
				v-else-if="reverseDnsChecked && reverseDns && reverseDns.hasPtr"
				class="text-sm text-warning mt-2"
			>
				PTR record found (<code class="bg-bg-deep px-1.5 py-0.5 rounded text-xs">{{
					reverseDns.ptrValue
				}}</code
				>) but it doesn't match
				<code class="bg-bg-deep px-1.5 py-0.5 rounded text-xs">{{ reverseDns.checkedHost }}</code
				>. Ask your host to set the reverse DNS (PTR) for this IP to the mail host so it
				forward-confirms.
			</p>
			<p
				v-else-if="reverseDnsChecked && reverseDns && !reverseDns.hasPtr"
				class="text-sm text-warning mt-2"
			>
				No PTR record found for
				<code class="bg-bg-deep px-1.5 py-0.5 rounded text-xs">{{ reverseDns.checkedHost }}</code>
				— ask your host to set reverse DNS (PTR) for the mail host's IP, or Gmail/Yahoo may reject
				or spam-folder your mail.
			</p>
		</div>
	</div>
</template>
