<script setup lang="ts">
import type { DeliverabilitySetupValue } from '~/utils/deliverabilityCenter';

const props = defineProps<{
	setupValues: readonly DeliverabilitySetupValue[];
	scopeKey: string;
}>();

const { t } = useI18n();
const { copy, isCopied } = useCopyToClipboard();

/** `copyLabel` is the field's name as the copy button's accessible name words it. */
type SetupField = { label: string; copyLabel: string; value: string; key: string };
type SetupPresentation = {
	setupValue: DeliverabilitySetupValue;
	identifier: string;
	fields: readonly SetupField[];
};

const KEY = 'components.delivery.deliverabilitySetupValues';

/** A field's heading and the lower-case form its copy button says. */
function field(name: string, key: string, value: string): SetupField {
	return {
		label: t(`${KEY}.fields.${name}`),
		copyLabel: t(`${KEY}.copyLabels.${name}`),
		value,
		key,
	};
}

function setupPresentation(setupValue: DeliverabilitySetupValue): SetupPresentation {
	switch (setupValue.kind) {
		case 'dns_record':
			return {
				setupValue,
				identifier: setupValue.name,
				fields: [
					field('name', 'name', setupValue.name),
					field('type', 'recordType', setupValue.recordType),
					field('value', 'value', setupValue.value),
					field('ttl', 'ttl', String(setupValue.ttl)),
				],
			};
		case 'spf_mechanisms':
			return {
				setupValue,
				identifier: setupValue.domain,
				fields: [
					field('domain', 'domain', setupValue.domain),
					field('mechanisms', 'mechanisms', setupValue.mechanisms.join(' ')),
				],
			};
		case 'smtp_setting':
			return {
				setupValue,
				identifier: 'EHLO hostname',
				fields: [
					field('setting', 'setting', 'EHLO hostname'),
					field('value', 'value', setupValue.value),
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
							:aria-label="
								t('components.delivery.deliverabilitySetupValues.copyAria', {
									field: field.copyLabel,
									identifier: presentation.identifier,
								})
							"
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
									? t('common.copied')
									: t('common.copy')
							}}
						</button>
					</dd>
				</template>
			</dl>
		</div>
	</div>
</template>
