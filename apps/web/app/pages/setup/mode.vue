<script setup lang="ts">
import {
	OPERATING_MODES,
	OPERATING_MODE_KEYS,
	operatingModeFlags,
	type OperatingModeKey,
} from '@owlat/shared/operatingModes';
import { SETUP_WIZARD_STEPS } from '~/composables/useSetupWizard';

definePageMeta({ layout: false });

const { t } = useI18n();

useHead({ title: () => t('setup.mode.pageTitle') });

const router = useRouter();
const { flags, isMigrationMode, goToStep } = useSetupWizard();
const { getStepStatus, isConnectorHighlighted } = useWizard(SETUP_WIZARD_STEPS, 'mode');

// `SETUP_WIZARD_STEPS` carries message KEYS (it is built at module scope); the
// indicator renders display text, so resolve them here — as a computed, so the
// labels follow a locale switch instead of freezing at setup.
const displaySteps = computed(() =>
	SETUP_WIZARD_STEPS.map((step) => ({ ...step, label: t(step.label) }))
);

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
	<div class="relative isolate min-h-screen overflow-hidden bg-bg-base text-text-primary">
		<UiHeroField />

		<div class="relative mx-auto max-w-3xl px-6 py-12">
			<div class="flex items-center gap-3 mb-8">
				<UiIconBox icon="lucide:feather" size="md" variant="brand" rounded="xl" />
				<span class="lp-eyebrow">{{ t('setup.mode.eyebrow') }}</span>
			</div>

			<UiStepIndicator
				class="mb-10"
				:steps="displaySteps"
				:get-step-status="getStepStatus as (stepId: string) => 'completed' | 'current' | 'upcoming'"
				:is-connector-highlighted="isConnectorHighlighted"
				:on-step-click="goToStep"
			/>

			<header class="mb-6">
				<I18nT
					keypath="setup.mode.title"
					tag="h1"
					scope="global"
					class="text-3xl font-medium tracking-[-0.02em] mb-2"
				>
					<template #brand><span class="lp-title-accent">Owlat</span></template>
				</I18nT>
				<I18nT
					keypath="setup.mode.intro"
					tag="p"
					scope="global"
					class="text-text-secondary leading-relaxed"
				>
					<template #docsLink>
						<a
							href="https://docs.owlat.app/guide/operating-modes"
							target="_blank"
							rel="noopener"
							class="link"
							>{{ t('setup.mode.docsLink') }}</a
						>
					</template>
				</I18nT>
			</header>

			<!-- Fresh start vs. migration. Default: fresh (Owlat is its own platform).
			     When "moving" is chosen, first-login onboarding offers a mail import. -->
			<fieldset class="card mb-8 p-5">
				<legend class="px-2 text-sm font-medium text-text-primary">
					{{ t('setup.mode.migrationLegend') }}
				</legend>
				<div class="mt-2 grid gap-3 sm:grid-cols-2">
					<button
						type="button"
						:aria-pressed="!isMigrationMode"
						class="rounded-xl border p-4 text-left transition-[border-color,background-color,box-shadow] duration-(--motion-fast) ease-spring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
						:class="
							!isMigrationMode
								? 'border-brand shadow-surface-2 bg-brand-soft'
								: 'border-transparent bg-surface-1 shadow-surface-1 hover:shadow-surface-2'
						"
						@click="isMigrationMode = false"
					>
						<span class="flex items-center gap-2 font-medium text-text-primary">
							<Icon name="lucide:sparkles" class="h-4 w-4" />
							{{ t('setup.mode.freshTitle') }}
						</span>
						<span class="mt-1 block text-sm text-text-secondary">{{
							t('setup.mode.freshDesc')
						}}</span>
					</button>
					<button
						type="button"
						:aria-pressed="isMigrationMode"
						class="rounded-xl border p-4 text-left transition-[border-color,background-color,box-shadow] duration-(--motion-fast) ease-spring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
						:class="
							isMigrationMode
								? 'border-brand shadow-surface-2 bg-brand-soft'
								: 'border-transparent bg-surface-1 shadow-surface-1 hover:shadow-surface-2'
						"
						@click="isMigrationMode = true"
					>
						<span class="flex items-center gap-2 font-medium text-text-primary">
							<Icon name="lucide:import" class="h-4 w-4" />
							{{ t('setup.mode.migratingTitle') }}
						</span>
						<span class="mt-1 block text-sm text-text-secondary">{{
							t('setup.mode.migratingDesc')
						}}</span>
					</button>
				</div>
			</fieldset>

			<ul class="space-y-3">
				<li v-for="key in OPERATING_MODE_KEYS" :key="key">
					<button
						type="button"
						class="group w-full text-left rounded-xl border border-transparent bg-surface-1 shadow-surface-1 p-5 transition-[border-color,box-shadow] duration-(--motion-fast) ease-spring hover:shadow-surface-2"
						@click="pick(key)"
					>
						<div class="flex flex-wrap items-center gap-2">
							<span class="font-medium text-text-primary">{{ t(OPERATING_MODES[key].label) }}</span>
							<UiBadge v-if="OPERATING_MODES[key].needsDeliveryProvider" variant="warning">{{
								t('setup.mode.needsDeliveryProvider')
							}}</UiBadge>
							<UiBadge v-else-if="OPERATING_MODES[key].needsMta" variant="neutral">{{
								t('setup.mode.needsMta')
							}}</UiBadge>
							<UiBadge v-else variant="neutral">{{ t('setup.mode.noProviderNeeded') }}</UiBadge>
						</div>
						<p class="mt-1.5 text-sm text-text-secondary">{{ t(OPERATING_MODES[key].audience) }}</p>
						<p class="mt-1 text-sm text-text-tertiary">{{ t(OPERATING_MODES[key].description) }}</p>
					</button>
				</li>
			</ul>

			<footer class="mt-8 flex items-center justify-between border-t border-border-subtle pt-6">
				<UiButton variant="ghost" @click="router.push('/setup')">
					<template #iconLeft><Icon name="lucide:arrow-left" class="w-4 h-4 mr-2" /></template>
					{{ t('common.back') }}
				</UiButton>
				<UiButton variant="secondary" @click="custom">
					{{ t('setup.mode.custom') }}
					<template #iconRight><Icon name="lucide:arrow-right" class="w-4 h-4 ml-2" /></template>
				</UiButton>
			</footer>
		</div>
	</div>
</template>
