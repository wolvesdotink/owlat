<script setup lang="ts">
import { computed, watch } from "vue";
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

const isEnabled = defineModel<boolean>("enabled", { required: true });
const relay = defineModel<string>("relay", { required: true });
const isWarmupOverflowEnabled = defineModel<boolean>("warmupOverflow", { required: true });
// Every enabled non-MTA transport, not "the one called ses" — the same
// capability question `lib/sendProviders/fallbackEligibility.ts` asks (plan D6).
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
		<label class="flex items-start gap-3 cursor-pointer">
			<input
				v-model="isEnabled"
				type="checkbox"
				class="mt-1 rounded border-border-subtle text-brand focus:ring-brand"
			/>
			<span>
				<span class="block text-sm font-medium text-text-primary">
					{{ t('components.delivery.deliverabilityFallbackEditor.escapeHatchLabel') }}
				</span>
				<span class="block text-xs text-text-tertiary mt-0.5">
					{{ t('components.delivery.deliverabilityFallbackEditor.escapeHatchHint') }}
				</span>
			</span>
		</label>
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
			<label v-if="messageType === 'campaign'" class="flex items-start gap-2 cursor-pointer">
				<input
					v-model="isWarmupOverflowEnabled"
					type="checkbox"
					class="mt-0.5 rounded border-border-subtle text-brand focus:ring-brand"
				/>
				<span class="text-sm text-text-secondary">
					{{ t('components.delivery.deliverabilityFallbackEditor.warmupOverflowLabel') }}
				</span>
			</label>
		</div>
	</div>
</template>
