<script setup lang="ts">
import {
	FEATURE_PACKS,
	ALL_FEATURE_PACK_KEYS,
	applyPackToggle,
	getFlagsByCategory,
	isPackEnabled,
	needsDeliveryProvider,
	type FeatureFlagKey,
	type FeaturePackKey,
} from '@owlat/shared/featureFlags';
import { SETUP_WIZARD_STEPS } from '~/composables/useSetupWizard';

definePageMeta({ layout: false });
useHead({ title: 'Owlat setup — Features' });

const router = useRouter();
const { flags, resolved } = useSetupWizard();
const { getStepStatus, isConnectorHighlighted } = useWizard(SETUP_WIZARD_STEPS, 'features');

const byCategory = computed(() => getFlagsByCategory());
const sendingNeedsProvider = computed(() => needsDeliveryProvider(flags.value));

function categoryLabel(cat: string): string {
	const map: Record<string, string> = {
		sending: 'Sending',
		receiving: 'Receiving',
		ai: 'AI',
		integrations: 'Integrations',
		security: 'Security & scanning',
		deliverability: 'Analytics & deliverability',
	};
	return map[cat] ?? cat;
}

function toggle(key: FeatureFlagKey) {
	flags.value = { ...flags.value, [key]: !resolved.value[key] };
}

const packState = computed(() => {
	const state: Record<FeaturePackKey, 'on' | 'off' | 'partial'> = {} as Record<
		FeaturePackKey,
		'on' | 'off' | 'partial'
	>;
	for (const key of ALL_FEATURE_PACK_KEYS) {
		state[key] = isPackEnabled(flags.value, key);
	}
	return state;
});

function togglePack(packKey: FeaturePackKey) {
	const nextValue = packState.value[packKey] !== 'on';
	const { next: nextFlags } = applyPackToggle(flags.value, packKey, nextValue);
	flags.value = nextFlags;
}
</script>

<template>
	<div class="min-h-screen bg-bg-base text-text-primary">
		<div class="mx-auto max-w-3xl px-6 py-12">
			<div class="flex items-center gap-3 mb-8">
				<UiIconBox icon="lucide:feather" size="md" variant="brand" rounded="xl" />
				<span class="text-sm font-medium text-text-secondary tracking-wide uppercase">Owlat setup</span>
			</div>

			<UiStepIndicator
				class="mb-10"
				:steps="SETUP_WIZARD_STEPS"
				:get-step-status="
					getStepStatus as (stepId: string) => 'completed' | 'current' | 'upcoming'
				"
				:is-connector-highlighted="isConnectorHighlighted"
			/>

			<header class="mb-6">
				<h1 class="font-display text-3xl mb-2">Pick what to enable</h1>
				<p class="text-text-secondary leading-relaxed">
					Toggle a master feature off and its sub-features disable automatically. You can change all
					of this later.
				</p>
			</header>

			<div v-if="sendingNeedsProvider" class="mb-6">
				<UiErrorAlert
					variant="info"
					title="A delivery provider is required next"
					message="Campaigns, transactional, or automations are enabled — the Email step will require a delivery provider (MTA, Resend, or SES). A connected external mailbox is not one."
				/>
			</div>

			<UiCard padding="lg" class="mb-6">
				<h2 class="font-medium text-text-primary">Feature packs</h2>
				<p class="text-sm text-text-tertiary mb-4">Pick a bundle. Toggling a pack flips every flag it contains.</p>
				<ul class="space-y-2">
					<li
						v-for="packKey in ALL_FEATURE_PACK_KEYS"
						:key="packKey"
						class="rounded-lg border border-border-subtle p-4 transition-colors"
						:class="{ 'opacity-60': packState[packKey] === 'off' }"
					>
						<label class="flex items-start gap-3 cursor-pointer">
							<input
								type="checkbox"
								class="mt-1 h-4 w-4 rounded border-border-default bg-bg-deep text-brand focus:ring-brand focus:ring-offset-0"
								:checked="packState[packKey] === 'on'"
								:indeterminate.prop="packState[packKey] === 'partial'"
								@change="togglePack(packKey)"
							/>
							<div class="flex-1">
								<div class="flex items-baseline gap-2 font-medium text-text-primary">
									{{ FEATURE_PACKS[packKey].label }}
									<UiBadge v-if="packState[packKey] === 'partial'" variant="neutral">partial</UiBadge>
								</div>
								<p class="text-sm text-text-secondary mt-0.5">{{ FEATURE_PACKS[packKey].description }}</p>
							</div>
						</label>
					</li>
				</ul>
			</UiCard>

			<section v-for="(defs, cat) in byCategory" :key="cat" class="mb-6">
				<h2 class="text-xs font-semibold uppercase tracking-wide text-text-tertiary mb-3">{{ categoryLabel(cat) }}</h2>
				<ul class="space-y-2">
					<li
						v-for="def in defs"
						:key="def.key"
						class="rounded-lg border border-border-subtle bg-bg-elevated p-4 transition-colors"
						:class="{ 'opacity-60': !resolved[def.key] }"
					>
						<label class="flex items-start gap-3 cursor-pointer">
							<input
								type="checkbox"
								class="mt-1 h-4 w-4 rounded border-border-default bg-bg-deep text-brand focus:ring-brand focus:ring-offset-0 disabled:opacity-50"
								:checked="resolved[def.key]"
								:disabled="!!def.requires?.some((dep) => !resolved[dep as FeatureFlagKey])"
								@change="toggle(def.key)"
							/>
							<div class="flex-1">
								<div class="flex items-baseline gap-2 font-medium text-text-primary">
									{{ def.label }}
									<span v-if="def.requires?.length" class="text-xs font-normal text-text-tertiary">requires: {{ def.requires.join(', ') }}</span>
								</div>
								<p class="text-sm text-text-secondary mt-0.5">{{ def.description }}</p>
							</div>
						</label>
					</li>
				</ul>
			</section>

			<footer class="mt-8 flex items-center justify-between border-t border-border-subtle pt-6">
				<UiButton variant="ghost" @click="router.push('/setup/mode')">
					<template #iconLeft><Icon name="lucide:arrow-left" class="w-4 h-4 mr-2" /></template>
					Back
				</UiButton>
				<UiButton @click="router.push('/setup/email')">
					Next: Email provider
					<template #iconRight><Icon name="lucide:arrow-right" class="w-4 h-4 ml-2" /></template>
				</UiButton>
			</footer>
		</div>
	</div>
</template>
