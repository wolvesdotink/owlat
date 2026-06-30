<script setup lang="ts">
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
}

const props = defineProps<Props>();

const { copy, isCopied } = useCopyToClipboard();

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
		</div>
	</div>
</template>
