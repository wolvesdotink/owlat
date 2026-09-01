<script setup lang="ts">
import { SETUP_STEPS, setupStepPath } from '~/composables/useSetupWizard';

definePageMeta({ layout: false });

const { t } = useI18n();

useHead({ title: () => t('setup.index.pageTitle') });

const router = useRouter();

/**
 * The splash's preview of the wizard, DERIVED from the wizard's own step list.
 *
 * It used to be a hand-written array, and it drifted: it promised four steps
 * (mode → features → email → "Admin & review") while `SETUP_STEPS` has run five
 * since the admin step was split out, so the first-run screen quietly lied about
 * the journey and then produced an unannounced account step. Mapping the real
 * list means the promise cannot diverge from the wizard again — a step added
 * there appears here, and its copy is keyed by the step's own id.
 */
const steps = computed(() =>
	SETUP_STEPS.map((step) => ({
		id: step.id,
		number: step.number,
		title: t(`setup.index.steps.${step.id}.title`),
		desc: t(`setup.index.steps.${step.id}.desc`),
	}))
);

function start() {
	router.push(setupStepPath(SETUP_STEPS[0].id));
}
</script>

<template>
	<div
		class="relative isolate min-h-screen overflow-hidden bg-bg-base text-text-primary grid place-items-center px-6 py-12"
	>
		<UiHeroField />

		<div class="relative w-full max-w-xl">
			<UiCard padding="lg">
				<div class="flex items-center gap-3 mb-6">
					<UiIconBox icon="lucide:feather" size="lg" variant="brand" rounded="2xl" />
					<span class="lp-eyebrow">{{ t('setup.index.eyebrow') }}</span>
				</div>

				<I18nT
					keypath="setup.index.title"
					tag="h1"
					scope="global"
					class="text-4xl font-medium tracking-[-0.02em] leading-tight mb-3"
				>
					<template #brand><span class="lp-title-accent">Owlat</span></template>
				</I18nT>
				<I18nT
					keypath="setup.index.intro"
					tag="p"
					scope="global"
					class="text-text-secondary leading-relaxed mb-6"
				>
					<template #location>
						<span class="font-mono text-sm text-text-primary">{{
							t('setup.index.settingsFeatures')
						}}</span>
					</template>
				</I18nT>

				<ol class="space-y-3 mb-8">
					<li v-for="step in steps" :key="step.id" class="flex items-start gap-3">
						<span
							class="flex items-center justify-center size-6 shrink-0 rounded-full bg-bg-surface text-text-tertiary border border-border-subtle text-xs font-medium mt-0.5"
						>
							{{ step.number }}
						</span>
						<div>
							<div class="font-medium text-text-primary">{{ step.title }}</div>
							<div class="text-sm text-text-secondary">{{ step.desc }}</div>
						</div>
					</li>
				</ol>

				<UiButton size="lg" @click="start">
					{{ t('setup.index.start') }}
					<template #iconRight><Icon name="lucide:arrow-right" class="w-4 h-4 ml-2" /></template>
				</UiButton>

				<I18nT
					keypath="setup.index.laterNote"
					tag="p"
					scope="global"
					class="mt-6 text-sm text-text-tertiary"
				>
					<template #settings>
						<span class="font-mono text-text-secondary">{{ t('common.settings') }}</span>
					</template>
				</I18nT>
				<I18nT
					keypath="setup.index.terminalNote"
					tag="p"
					scope="global"
					class="mt-2 text-sm text-text-tertiary"
				>
					<template #command>
						<code class="font-mono text-text-secondary bg-bg-surface rounded px-1.5 py-0.5"
							>owlat setup --terminal</code
						>
					</template>
				</I18nT>
			</UiCard>
		</div>
	</div>
</template>
