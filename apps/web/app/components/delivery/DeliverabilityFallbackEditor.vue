<script setup lang="ts">
import { computed, useId, watch } from "vue";
import { eligibleFallbackRelays } from "~/utils/providerRouting";

interface ProviderEntry {
	providerType: string;
	isEnabled: boolean;
}

const props = defineProps<{
	messageType: "campaign" | "transactional" | "automation";
	providers: ProviderEntry[];
	providerLabel: (providerType: string) => string;
}>();

const { t } = useI18n();
const idBase = useId();
const escapeHatchLabelId = `${idBase}-escape-hatch`;
const escapeHatchHintId = `${idBase}-escape-hatch-hint`;
const warmupOverflowLabelId = `${idBase}-warmup-overflow`;

const isEnabled = defineModel<boolean>("enabled", { required: true });
const relay = defineModel<string>("relay", { required: true });
const isWarmupOverflowEnabled = defineModel<boolean>("warmupOverflow", { required: true });
// Every enabled non-MTA transport, not "the one called ses" — the same
// capability question `lib/sendProviders/fallbackEligibility.ts` asks.
const enabledRelays = computed(() => eligibleFallbackRelays(props.providers));

watch(
	enabledRelays,
	(options) => {
		if (!options.some((provider) => provider.providerType === relay.value)) {
			relay.value = options[0]?.providerType ?? "";
		}
	},
	{ immediate: true },
);
</script>

<template>
	<div class="rounded-lg border border-border-subtle p-4 space-y-3">
		<div class="flex items-start justify-between gap-3">
			<span>
				<span :id="escapeHatchLabelId" class="block text-sm font-medium text-text-primary">
					{{ t('components.delivery.deliverabilityFallbackEditor.escapeHatchLabel') }}
				</span>
				<span :id="escapeHatchHintId" class="block text-xs text-text-tertiary mt-0.5">
					{{ t('components.delivery.deliverabilityFallbackEditor.escapeHatchHint') }}
				</span>
			</span>
			<UiSwitch
				v-model="isEnabled"
				:aria-labelledby="escapeHatchLabelId"
				:aria-describedby="escapeHatchHintId"
			/>
		</div>
		<div v-if="isEnabled" class="space-y-3 pl-7">
			<div>
				<label for="fallback-relay" class="label">
					{{ t('components.delivery.deliverabilityFallbackEditor.relayLabel') }}
				</label>
				<select id="fallback-relay" v-model="relay" class="input">
					<option
						v-for="provider in enabledRelays"
						:key="provider.providerType"
						:value="provider.providerType"
					>
						{{ providerLabel(provider.providerType) }}
					</option>
				</select>
				<p v-if="!enabledRelays.length" class="mt-1 text-xs text-warning">
					{{ t('components.delivery.deliverabilityFallbackEditor.noRelayEnabled') }}
				</p>
				<p class="mt-1 text-xs text-text-tertiary">
					{{ t('components.delivery.deliverabilityFallbackEditor.relayHint') }}
				</p>
			</div>
			<div v-if="messageType === 'campaign'" class="flex items-start justify-between gap-3">
				<span :id="warmupOverflowLabelId" class="text-sm text-text-secondary">
					{{ t('components.delivery.deliverabilityFallbackEditor.warmupOverflowLabel') }}
				</span>
				<UiSwitch v-model="isWarmupOverflowEnabled" :aria-labelledby="warmupOverflowLabelId" />
			</div>
		</div>
	</div>
</template>
