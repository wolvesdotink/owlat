<script setup lang="ts">
import type { DeliverabilitySetupValue } from '~/utils/deliverabilityCenter';

const props = defineProps<{
	setupValues: readonly DeliverabilitySetupValue[];
	scopeKey: string;
}>();

const { copy, isCopied } = useCopyToClipboard();

type SetupField = { label: string; value: string; key: string };
type SetupPresentation = {
	setupValue: DeliverabilitySetupValue;
	identifier: string;
	fields: readonly SetupField[];
};

function setupPresentation(setupValue: DeliverabilitySetupValue): SetupPresentation {
	switch (setupValue.kind) {
		case 'dns_record':
			return {
				setupValue,
				identifier: setupValue.name,
				fields: [
					{ label: 'Name', value: setupValue.name, key: 'name' },
					{ label: 'Type', value: setupValue.recordType, key: 'recordType' },
					{ label: 'Value', value: setupValue.value, key: 'value' },
					{ label: 'TTL', value: String(setupValue.ttl), key: 'ttl' },
				],
			};
		case 'spf_mechanisms':
			return {
				setupValue,
				identifier: setupValue.domain,
				fields: [
					{ label: 'Domain', value: setupValue.domain, key: 'domain' },
					{ label: 'Mechanisms', value: setupValue.mechanisms.join(' '), key: 'mechanisms' },
				],
			};
		case 'smtp_setting':
			return {
				setupValue,
				identifier: 'EHLO hostname',
				fields: [
					{ label: 'Setting', value: 'EHLO hostname', key: 'setting' },
					{ label: 'Value', value: setupValue.value, key: 'value' },
				],
			};
	}
}

const presentedSetupValues = computed(() => props.setupValues.map(setupPresentation));
</script>

<template>
	<div class="space-y-3">
		<div
			v-for="presentation in presentedSetupValues"
			:key="`${scopeKey}:${presentation.setupValue.id}`"
			class="rounded-lg border border-border-subtle bg-bg-deep/40 p-4"
		>
			<p class="text-sm font-medium text-text-primary">{{ presentation.setupValue.label }}</p>
			<p
				v-if="presentation.setupValue.kind === 'spf_mechanisms'"
				class="mt-1 text-xs text-text-secondary"
			>
				{{ presentation.setupValue.instruction }}
			</p>
			<dl class="mt-3 grid gap-3 text-sm sm:grid-cols-[6rem_minmax(0,1fr)]">
				<template v-for="field in presentation.fields" :key="field.key">
					<dt class="text-text-tertiary">{{ field.label }}</dt>
					<dd class="flex min-w-0 items-start gap-2">
						<code
							class="min-w-0 flex-1 select-all break-all rounded bg-bg-surface px-2 py-1 font-mono text-xs text-text-primary"
							>{{ field.value }}</code
						>
						<button
							type="button"
							class="inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs font-medium text-brand hover:bg-brand/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
							:aria-label="`Copy ${field.label.toLowerCase()} for ${presentation.identifier}`"
							@click="copy(field.value, `${scopeKey}:${presentation.setupValue.id}:${field.key}`)"
						>
							<Icon
								:name="
									isCopied(`${scopeKey}:${presentation.setupValue.id}:${field.key}`)
										? 'lucide:check'
										: 'lucide:copy'
								"
								class="h-3.5 w-3.5"
							/>
							{{
								isCopied(`${scopeKey}:${presentation.setupValue.id}:${field.key}`)
									? 'Copied'
									: 'Copy'
							}}
						</button>
					</dd>
				</template>
			</dl>
		</div>
	</div>
</template>
