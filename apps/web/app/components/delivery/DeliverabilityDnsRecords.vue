<script setup lang="ts">
import type { DeliverabilityDnsRecord } from "~/utils/deliverabilityCenter";

defineProps<{
	records: readonly DeliverabilityDnsRecord[];
	scopeKey: string;
}>();

const { copy, isCopied } = useCopyToClipboard();

function recordFields(record: DeliverabilityDnsRecord) {
	return [
		{ label: "Name", value: record.name, key: "name" },
		{ label: "Type", value: record.type, key: "type" },
		{ label: "Value", value: record.value, key: "value" },
		{ label: "TTL", value: String(record.ttl), key: "ttl" },
	] as const;
}
</script>

<template>
	<div class="space-y-3">
		<div
			v-for="record in records"
			:key="`${scopeKey}:${record.id}`"
			class="rounded-lg border border-border-subtle bg-bg-deep/40 p-4"
		>
			<p class="text-sm font-medium text-text-primary">{{ record.label }}</p>
			<dl class="mt-3 grid gap-3 text-sm sm:grid-cols-[6rem_minmax(0,1fr)]">
				<template v-for="field in recordFields(record)" :key="field.key">
					<dt class="text-text-tertiary">{{ field.label }}</dt>
					<dd class="flex min-w-0 items-start gap-2">
						<code
							class="min-w-0 flex-1 select-all break-all rounded bg-bg-surface px-2 py-1 font-mono text-xs text-text-primary"
							>{{ field.value }}</code
						>
						<button
							type="button"
							class="inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs font-medium text-brand hover:bg-brand/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
							:aria-label="`Copy ${field.label.toLowerCase()} for ${record.name}`"
							@click="copy(field.value, `${scopeKey}:${record.id}:${field.key}`)"
						>
							<Icon
								:name="
									isCopied(`${scopeKey}:${record.id}:${field.key}`) ? 'lucide:check' : 'lucide:copy'
								"
								class="h-3.5 w-3.5"
							/>
							{{ isCopied(`${scopeKey}:${record.id}:${field.key}`) ? "Copied" : "Copy" }}
						</button>
					</dd>
				</template>
			</dl>
		</div>
	</div>
</template>
