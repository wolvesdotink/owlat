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
 * install) — the parent additionally gates on an inbound feature flag.
 */
import { buildInboundMxRecords } from '~/utils/inboundDns';

const props = defineProps<{
	/** The sending domain whose inbound MX records to derive. */
	domain: string;
	/** This deployment's mail host (MTA EHLO hostname), or null when unset. */
	mailHost: string | null | undefined;
	/** The inbound SMTP port other mail servers deliver to. */
	inboundPort: number;
}>();

const mxRecords = computed(() => buildInboundMxRecords(props.domain, props.mailHost));
</script>

<template>
	<div v-if="mxRecords.length > 0" class="pt-2">
		<p class="text-xs font-medium text-text-tertiary uppercase tracking-wider mb-2">
			Receiving (inbound mail)
		</p>
		<p class="text-sm text-text-secondary mb-3">
			To receive mail for <strong class="text-text-primary">{{ domain }}</strong> through this
			Owlat instance, publish the MX record below. Inbound mail is delivered to this
			deployment's mail host
			(<code class="bg-bg-surface px-1.5 py-0.5 rounded text-xs">{{ mailHost }}</code>).
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

		<div class="mt-4 p-4 bg-bg-surface rounded-xl border border-border-subtle">
			<p class="text-sm text-text-secondary">
				<strong class="text-text-primary">Inbound port + firewall:</strong>
				other mail servers connect to
				<code class="bg-bg-deep px-1.5 py-0.5 rounded text-xs">{{ mailHost }}</code>
				on TCP port
				<code class="bg-bg-deep px-1.5 py-0.5 rounded text-xs">{{ inboundPort }}</code>
				to deliver mail, so open inbound TCP {{ inboundPort }} on your firewall / security
				group. Many cloud providers block port {{ inboundPort }} by default — confirm your
				host allows inbound SMTP, and set reverse DNS (PTR) for the mail host's IP.
			</p>
		</div>
	</div>
</template>
