<script setup lang="ts">
import {
	OPERATING_MODES,
	OPERATING_MODE_KEYS,
	operatingModeFlags,
	type OperatingModeKey,
} from '@owlat/shared/operatingModes';
import { SETUP_WIZARD_STEPS } from '~/composables/useSetupWizard';

definePageMeta({ layout: false });
useHead({ title: 'Owlat setup — Operating mode' });

const router = useRouter();
const { flags, isMigrationMode } = useSetupWizard();
const { getStepStatus, isConnectorHighlighted } = useWizard(SETUP_WIZARD_STEPS, 'mode');

// Pre-fill the flag set from a named mode, then continue to the fine-tune step.
function pick(key: OperatingModeKey) {
	flags.value = operatingModeFlags(key);
	router.push('/setup/features');
}

// Start from defaults and tune everything by hand.
function custom() {
	router.push('/setup/features');
}
</script>

<template>
	<div class="min-h-screen bg-bg-base text-text-primary">
		<div class="mx-auto max-w-3xl px-6 py-12">
			<div class="flex items-center gap-3 mb-8">
				<UiIconBox icon="lucide:feather" size="md" variant="brand" rounded="xl" />
				<span class="text-sm font-medium text-text-secondary tracking-wide uppercase"
					>Owlat setup</span
				>
			</div>

			<UiStepIndicator
				class="mb-10"
				:steps="SETUP_WIZARD_STEPS"
				:get-step-status="getStepStatus as (stepId: string) => 'completed' | 'current' | 'upcoming'"
				:is-connector-highlighted="isConnectorHighlighted"
			/>

			<header class="mb-6">
				<h1 class="font-display text-3xl mb-2">How will you run Owlat?</h1>
				<p class="text-text-secondary leading-relaxed">
					Pick the closest mode to pre-fill your features — you can fine-tune everything on the next
					step. See
					<a
						href="https://docs.owlat.app/guide/operating-modes"
						target="_blank"
						rel="noopener"
						class="text-brand hover:text-brand-hover underline"
						>Operating Modes</a
					>
					for the full matrix.
				</p>
			</header>

			<!-- Fresh start vs. migration. Default: fresh (Owlat is its own platform).
			     When "moving" is chosen, first-login onboarding offers a mail import. -->
			<fieldset class="mb-8 rounded-xl border border-border-default bg-bg-elevated p-5">
				<legend class="px-2 text-sm font-medium text-text-primary">
					Are you moving from another platform, or starting fresh on Owlat?
				</legend>
				<div class="mt-2 grid gap-3 sm:grid-cols-2">
					<button
						type="button"
						:aria-pressed="!isMigrationMode"
						class="rounded-lg border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
						:class="
							!isMigrationMode
								? 'border-brand bg-brand/5'
								: 'border-border-default hover:border-brand'
						"
						@click="isMigrationMode = false"
					>
						<span class="flex items-center gap-2 font-medium text-text-primary">
							<Icon name="lucide:sparkles" class="h-4 w-4" />
							Starting fresh
						</span>
						<span class="mt-1 block text-sm text-text-secondary"
							>Owlat is our home. No import needed.</span
						>
					</button>
					<button
						type="button"
						:aria-pressed="isMigrationMode"
						class="rounded-lg border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
						:class="
							isMigrationMode
								? 'border-brand bg-brand/5'
								: 'border-border-default hover:border-brand'
						"
						@click="isMigrationMode = true"
					>
						<span class="flex items-center gap-2 font-medium text-text-primary">
							<Icon name="lucide:import" class="h-4 w-4" />
							Moving from another platform
						</span>
						<span class="mt-1 block text-sm text-text-secondary"
							>We'll offer new users a mail import at first login.</span
						>
					</button>
				</div>
			</fieldset>

			<ul class="space-y-3">
				<li v-for="key in OPERATING_MODE_KEYS" :key="key">
					<button
						type="button"
						class="group w-full text-left rounded-xl border border-border-default bg-bg-elevated p-5 transition-colors hover:border-brand"
						@click="pick(key)"
					>
						<div class="flex flex-wrap items-center gap-2">
							<span class="font-medium text-text-primary">{{ OPERATING_MODES[key].label }}</span>
							<UiBadge v-if="OPERATING_MODES[key].needsDeliveryProvider" variant="warning"
								>needs a delivery provider</UiBadge
							>
							<UiBadge v-else-if="OPERATING_MODES[key].needsMta" variant="neutral"
								>needs the built-in MTA</UiBadge
							>
							<UiBadge v-else variant="neutral">no provider needed</UiBadge>
						</div>
						<p class="mt-1.5 text-sm text-text-secondary">{{ OPERATING_MODES[key].audience }}</p>
						<p class="mt-1 text-sm text-text-tertiary">{{ OPERATING_MODES[key].description }}</p>
					</button>
				</li>
			</ul>

			<footer class="mt-8 flex items-center justify-between border-t border-border-subtle pt-6">
				<UiButton variant="ghost" @click="router.push('/setup')">
					<template #iconLeft><Icon name="lucide:arrow-left" class="w-4 h-4 mr-2" /></template>
					Back
				</UiButton>
				<UiButton variant="secondary" @click="custom">
					Custom / decide later
					<template #iconRight><Icon name="lucide:arrow-right" class="w-4 h-4 ml-2" /></template>
				</UiButton>
			</footer>
		</div>
	</div>
</template>
