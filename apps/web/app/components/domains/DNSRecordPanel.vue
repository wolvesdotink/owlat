<script setup lang="ts">
import type { SpfCoexistenceSuggestion } from '~/utils/spfCoexistence';

interface DNSRecord {
	type: string;
	host: string;
	value: string;
}

interface VerificationResult {
	verified: boolean;
	message?: string;
}

interface Props {
	record: DNSRecord;
	label: string;
	domain: string;
	verification?: VerificationResult;
	/**
	 * SPF-only: when the domain already publishes a foreign SPF record, this
	 * carries the existing record and the single merged record to publish
	 * instead (RFC 7208 §3.2 allows only one `v=spf1` record per host).
	 */
	coexistence?: SpfCoexistenceSuggestion;
}

const props = defineProps<Props>();

const { copy, isCopied } = useCopyToClipboard();

const handleCopyMerged = () => {
	if (props.coexistence) copy(props.coexistence.merged, `${props.label}-merged`);
};

const displayHost = computed(() => {
	if (props.record.host === '@') {
		return props.domain;
	}
	return `${props.record.host}.${props.domain}`;
});

const handleCopyHost = () => {
	copy(displayHost.value, `${props.label}-host`);
};

const handleCopyValue = () => {
	copy(props.record.value, `${props.label}-value`);
};
</script>

<template>
	<div class="bg-bg-elevated rounded-xl p-4 border border-border-subtle">
		<div class="flex items-center justify-between mb-2">
			<div class="flex items-center gap-2">
				<span class="px-2 py-0.5 bg-brand/20 text-brand text-xs font-medium rounded">
					{{ record.type }}
				</span>
				<span class="text-sm font-medium text-text-primary">{{ label }} Record</span>
			</div>
			<div
				v-if="verification"
				:class="[
					'flex items-center gap-1 text-xs',
					verification.verified ? 'text-success' : 'text-error',
				]"
			>
				<Icon :name="verification.verified ? 'lucide:check-circle-2' : 'lucide:x-circle'" class="w-3 h-3" />
				{{ verification.verified ? 'Verified' : 'Not verified' }}
			</div>
		</div>

		<div class="space-y-2">
			<!-- Host / Name -->
			<div>
				<p class="text-xs text-text-tertiary mb-1">Host / Name</p>
				<div class="flex items-center gap-2">
					<code
						class="flex-1 bg-bg-deep px-3 py-2 rounded-lg text-sm text-text-secondary font-mono break-all"
					>
						{{ displayHost }}
					</code>
					<button class="btn btn-ghost p-2" title="Copy host" @click="handleCopyHost">
						<Icon v-if="isCopied(`${label}-host`)" name="lucide:check" class="w-4 h-4 text-success" />
						<Icon v-else name="lucide:copy" class="w-4 h-4" />
					</button>
				</div>
			</div>

			<!-- Value -->
			<div>
				<p class="text-xs text-text-tertiary mb-1">Value</p>
				<div class="flex items-center gap-2">
					<code
						class="flex-1 bg-bg-deep px-3 py-2 rounded-lg text-sm text-text-secondary font-mono break-all"
					>
						{{ record.value }}
					</code>
					<button class="btn btn-ghost p-2" title="Copy value" @click="handleCopyValue">
						<Icon v-if="isCopied(`${label}-value`)" name="lucide:check" class="w-4 h-4 text-success" />
						<Icon v-else name="lucide:copy" class="w-4 h-4" />
					</button>
				</div>
			</div>

			<!-- SPF coexistence: a foreign SPF record already exists. Publishing a
			     second v=spf1 record is a PermError (RFC 7208 §3.2) that breaks SPF
			     for everyone, so offer a single merged record instead. -->
			<div v-if="coexistence" class="mt-3 rounded-lg border border-warning/30 bg-warning/10 p-3">
				<p class="flex items-start gap-2 text-xs font-medium text-warning">
					<Icon name="lucide:alert-triangle" class="mt-0.5 w-3.5 h-3.5 shrink-0" />
					<span>
						This domain already publishes an SPF record for another mail provider.
						Only one <code class="font-mono">v=spf1</code> record is allowed per host
						(RFC 7208 §3.2) — a second one breaks SPF for all your mail. Publish the
						merged record below instead of the value above. SPF allows at most 10 DNS
						lookups — double-check the merged record stays within that limit.
					</span>
				</p>
				<div class="mt-2">
					<p class="text-xs text-text-tertiary mb-1">Existing record</p>
					<code class="block bg-bg-deep px-3 py-2 rounded-lg text-xs text-text-tertiary font-mono break-all">
						{{ coexistence.existing }}
					</code>
				</div>
				<div class="mt-2">
					<p class="text-xs text-text-tertiary mb-1">Merged record to publish</p>
					<div class="flex items-center gap-2">
						<code
							class="flex-1 bg-bg-deep px-3 py-2 rounded-lg text-sm text-text-secondary font-mono break-all"
						>
							{{ coexistence.merged }}
						</code>
						<button class="btn btn-ghost p-2" title="Copy merged value" @click="handleCopyMerged">
							<Icon v-if="isCopied(`${label}-merged`)" name="lucide:check" class="w-4 h-4 text-success" />
							<Icon v-else name="lucide:copy" class="w-4 h-4" />
						</button>
					</div>
				</div>
			</div>
		</div>
	</div>
</template>
