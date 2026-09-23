<script setup lang="ts">
import {
	OPERATING_MODES,
	OPERATING_MODE_KEYS,
	operatingModeFlags,
	type OperatingModeKey,
} from '@owlat/shared/operatingModes';
import { SETUP_WIZARD_STEPS } from '~/composables/useSetupWizard';
import {
	DEFAULT_SETUP_OUTCOME,
	SETUP_OUTCOMES,
	outcomeAnswersEmail,
	outcomeFlags,
	type SetupOutcome,
} from '~/composables/setupWizardOutcomes';
import { setupChoiceClass } from '~/utils/setupChoiceCard';

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

// The question most teams can answer: what do you want to do? The answer
// pre-fills the feature flags; the next step fine-tunes them. "Both" is
// preselected, so continuing without a click is the recommended setup.
const outcome = useState<SetupOutcome>('setupOutcome', () => DEFAULT_SETUP_OUTCOME);
const aiDrafts = useState<boolean>('setupOutcomeAiDrafts', () => false);
const offersAiDrafts = computed(() => outcomeAnswersEmail(outcome.value));

function next() {
	flags.value = outcomeFlags(outcome.value, aiDrafts.value && offersAiDrafts.value);
	router.push('/setup/features');
}

// Advanced: start from one of the named operator presets instead.
function pick(key: OperatingModeKey) {
	flags.value = operatingModeFlags(key);
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
				<p class="text-text-secondary leading-relaxed">{{ t('setup.mode.intro') }}</p>
			</header>

			<form @submit.prevent="next">
				<!-- What the team wants to do, in their words. Selected cards use the
				     brand-tinted border the rest of the wizard shares (setupChoiceCard). -->
				<fieldset class="mb-8" data-testid="setup-outcomes">
					<legend class="mb-3 text-sm font-medium text-text-primary">
						{{ t('setup.mode.outcomeLegend') }}
					</legend>
					<div class="space-y-3">
						<label
							v-for="option in SETUP_OUTCOMES"
							:key="option.key"
							class="flex cursor-pointer items-start gap-3 p-5"
							:class="setupChoiceClass(outcome === option.key)"
							:data-testid="`setup-outcome-${option.key}`"
						>
							<input
								v-model="outcome"
								type="radio"
								name="setup-outcome"
								:value="option.key"
								class="mt-1 accent-brand"
							/>
							<UiIconBox
								:icon="option.icon"
								size="sm"
								:variant="outcome === option.key ? 'brand' : 'surface'"
								rounded="lg"
							/>
							<span class="min-w-0 flex-1">
								<span class="flex flex-wrap items-center gap-2 font-medium text-text-primary">
									{{ t(option.label) }}
									<UiBadge v-if="option.key === DEFAULT_SETUP_OUTCOME" variant="default">{{
										t('setup.mode.recommended')
									}}</UiBadge>
								</span>
								<span class="mt-1 block text-sm text-text-secondary">{{
									t(option.description)
								}}</span>
							</span>
						</label>
					</div>

					<div
						v-if="offersAiDrafts"
						class="mt-4 flex items-start justify-between gap-4"
						data-testid="setup-outcome-ai-drafts"
					>
						<div class="min-w-0">
							<label for="setup-ai-drafts" class="block text-sm font-medium text-text-primary">
								{{ t('setup.mode.aiDraftsLabel') }}
							</label>
							<p id="setup-ai-drafts-hint" class="text-sm text-text-tertiary">
								{{ t('setup.mode.aiDraftsHint') }}
							</p>
						</div>
						<UiSwitch
							id="setup-ai-drafts"
							v-model="aiDrafts"
							aria-describedby="setup-ai-drafts-hint"
						/>
					</div>
				</fieldset>

				<!-- Fresh start vs. migration. Default: fresh (Owlat is its own platform).
				     When "moving" is chosen, first-login onboarding offers a mail import. -->
				<fieldset class="mb-8">
					<legend class="mb-3 text-sm font-medium text-text-primary">
						{{ t('setup.mode.migrationLegend') }}
					</legend>
					<div class="grid gap-3 sm:grid-cols-2">
						<label
							class="flex cursor-pointer items-start gap-3 p-4"
							:class="setupChoiceClass(!isMigrationMode)"
						>
							<input
								type="radio"
								name="setup-migration"
								class="mt-1 accent-brand"
								:checked="!isMigrationMode"
								@change="isMigrationMode = false"
							/>
							<span>
								<span class="flex items-center gap-2 font-medium text-text-primary">
									<Icon name="lucide:sparkles" class="h-4 w-4" />
									{{ t('setup.mode.freshTitle') }}
								</span>
								<span class="mt-1 block text-sm text-text-secondary">{{
									t('setup.mode.freshDesc')
								}}</span>
							</span>
						</label>
						<label
							class="flex cursor-pointer items-start gap-3 p-4"
							:class="setupChoiceClass(isMigrationMode)"
						>
							<input
								type="radio"
								name="setup-migration"
								class="mt-1 accent-brand"
								:checked="isMigrationMode"
								@change="isMigrationMode = true"
							/>
							<span>
								<span class="flex items-center gap-2 font-medium text-text-primary">
									<Icon name="lucide:import" class="h-4 w-4" />
									{{ t('setup.mode.migratingTitle') }}
								</span>
								<span class="mt-1 block text-sm text-text-secondary">{{
									t('setup.mode.migratingDesc')
								}}</span>
							</span>
						</label>
					</div>
				</fieldset>

				<!-- The eight operator presets, for people who want a specific shape.
				     Picking one replaces the answer above and moves on. -->
				<details class="mb-2 rounded-xl bg-surface-1 shadow-surface-1" data-testid="setup-presets">
					<summary
						class="cursor-pointer select-none px-5 py-4 text-sm font-medium text-text-primary"
					>
						{{ t('setup.mode.advancedSummary') }}
					</summary>
					<div class="px-5 pb-5">
						<p class="mb-3 text-sm text-text-secondary">
							<I18nT keypath="setup.mode.advancedIntro" scope="global">
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
						</p>
						<ul class="space-y-3">
							<li v-for="key in OPERATING_MODE_KEYS" :key="key">
								<button
									type="button"
									class="w-full p-4"
									:class="setupChoiceClass(false)"
									:data-testid="`setup-preset-${key}`"
									@click="pick(key)"
								>
									<span class="flex flex-wrap items-center gap-2">
										<span class="font-medium text-text-primary">{{
											t(OPERATING_MODES[key].label)
										}}</span>
										<UiBadge v-if="OPERATING_MODES[key].needsDeliveryProvider" variant="neutral">{{
											t('setup.mode.needsDeliveryProvider')
										}}</UiBadge>
										<UiBadge v-else-if="OPERATING_MODES[key].needsMta" variant="neutral">{{
											t('setup.mode.needsMta')
										}}</UiBadge>
										<UiBadge v-else variant="neutral">{{
											t('setup.mode.noProviderNeeded')
										}}</UiBadge>
									</span>
									<span class="mt-1.5 block text-sm text-text-secondary">{{
										t(OPERATING_MODES[key].audience)
									}}</span>
									<span class="mt-1 block text-sm text-text-tertiary">{{
										t(OPERATING_MODES[key].description)
									}}</span>
								</button>
							</li>
						</ul>
					</div>
				</details>

				<footer class="mt-8 flex items-center justify-between border-t border-border-subtle pt-6">
					<UiButton type="button" variant="ghost" @click="router.push('/setup')">
						<template #iconLeft><Icon name="lucide:arrow-left" class="w-4 h-4 mr-2" /></template>
						{{ t('common.back') }}
					</UiButton>
					<UiButton type="submit" variant="primary" data-testid="setup-mode-next">
						{{ t('setup.mode.next') }}
						<template #iconRight><Icon name="lucide:arrow-right" class="w-4 h-4 ml-2" /></template>
					</UiButton>
				</footer>
			</form>
		</div>
	</div>
</template>
