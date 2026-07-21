<script setup lang="ts">
interface ProviderEntry {
	providerType: string;
	isEnabled: boolean;
}

const props = defineProps<{
	messageType: 'campaign' | 'transactional' | 'automation';
	providers: ProviderEntry[];
	providerLabel: (providerType: string) => string;
}>();

const isEnabled = defineModel<boolean>('enabled', { required: true });
const relay = defineModel<string>('relay', { required: true });
const isWarmupOverflowEnabled = defineModel<boolean>('warmupOverflow', { required: true });
const enabledRelays = computed(() =>
	props.providers.filter((provider) => provider.isEnabled && provider.providerType !== 'mta')
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
				<span class="block text-sm font-medium text-text-primary"
					>Automatic relay escape hatch</span
				>
				<span class="block text-xs text-text-tertiary mt-0.5">
					Move only an affected destination-provider slice off owned IPs. The sending domain must be
					currently verified for the relay; credentials alone never count.
				</span>
			</span>
		</label>
		<div v-if="isEnabled" class="space-y-3 pl-7">
			<div>
				<label for="fallback-relay" class="label">Verified relay</label>
				<select id="fallback-relay" v-model="relay" class="input">
					<option
						v-for="provider in enabledRelays"
						:key="provider.providerType"
						:value="provider.providerType"
					>
						{{ providerLabel(provider.providerType) }}
					</option>
				</select>
				<p class="mt-1 text-xs text-text-tertiary">
					SES identities are verified automatically. Other relays are refused until their
					provider-specific domain verification is available.
				</p>
			</div>
			<label v-if="messageType === 'campaign'" class="flex items-start gap-2 cursor-pointer">
				<input
					v-model="isWarmupOverflowEnabled"
					type="checkbox"
					class="mt-0.5 rounded border-border-subtle text-brand focus:ring-brand"
				/>
				<span class="text-sm text-text-secondary">
					Send overflow above the owned-IP warming cap through this relay. Owned-IP counters and
					caps remain unchanged.
				</span>
			</label>
		</div>
	</div>
</template>
