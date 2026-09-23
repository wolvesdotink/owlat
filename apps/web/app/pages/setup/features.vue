<script setup lang="ts">
import {
	applyPackToggle,
	applyToggle,
	FEATURE_FLAGS,
	FEATURE_PACKS,
	isPackEnabled,
	needsDeliveryProvider,
	SENDING_FLAGS_REQUIRING_DELIVERY,
	type FeatureFlagKey,
	type FeaturePackKey,
} from '@owlat/shared/featureFlags';
import { SETUP_WIZARD_STEPS } from '~/composables/useSetupWizard';
import FeaturePackList from '~/components/settings/FeaturePackList.vue';

definePageMeta({ layout: false });

const { t } = useI18n();

useHead({ title: () => t('setup.features.pageTitle') });

const router = useRouter();
const { flags, resolved, goToStep } = useSetupWizard();
const { getStepStatus, isConnectorHighlighted } = useWizard(SETUP_WIZARD_STEPS, 'features');

// `SETUP_WIZARD_STEPS` carries message KEYS (it is built at module scope); the
// indicator renders display text, so resolve them here — as a computed, so the
// labels follow a locale switch instead of freezing at setup.
const displaySteps = computed(() =>
	SETUP_WIZARD_STEPS.map((step) => ({ ...step, label: t(step.label) }))
);

// The "sending needs a delivery provider" note answers a choice, so it waits
// for one: it appears once the operator has switched sending on here (the
// Marketing pack or one of its sending flags), not on arrival. The Email step
// asks for the provider either way.
const choseSending = ref(false);
const showProviderNote = computed(() => choseSending.value && needsDeliveryProvider(flags.value));

const isSendingFlag = (key: FeatureFlagKey) =>
	(SENDING_FLAGS_REQUIRING_DELIVERY as readonly string[]).includes(key);

function toggleFlag(key: FeatureFlagKey, value: boolean) {
	flags.value = applyToggle(flags.value, key, value, FEATURE_FLAGS).next;
	if (value && isSendingFlag(key)) choseSending.value = true;
}

function togglePack(packKey: FeaturePackKey) {
	const nextValue = isPackEnabled(flags.value, packKey) !== 'on'; // off/partial → on
	const flagsInPack = FEATURE_PACKS[packKey].flags;
	flags.value = applyPackToggle(flags.value, packKey, nextValue, FEATURE_FLAGS).next;
	if (nextValue && flagsInPack.some(isSendingFlag)) choseSending.value = true;
}
</script>

<template>
	<div class="relative isolate min-h-screen overflow-hidden bg-bg-base text-text-primary">
		<UiHeroField />

		<div class="relative mx-auto max-w-3xl px-6 py-12">
			<div class="flex items-center gap-3 mb-8">
				<UiIconBox icon="lucide:feather" size="md" variant="brand" rounded="xl" />
				<span class="lp-eyebrow">{{ t('setup.features.eyebrow') }}</span>
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
					keypath="setup.features.title"
					tag="h1"
					scope="global"
					class="text-3xl font-medium tracking-[-0.02em] mb-2"
				>
					<template #accent>
						<span class="lp-title-accent">{{ t('setup.features.titleAccent') }}</span>
					</template>
				</I18nT>
				<p class="text-text-secondary leading-relaxed">
					{{ t('setup.features.intro') }}
				</p>
			</header>

			<FeaturePackList
				class="mb-6"
				:registry="FEATURE_FLAGS"
				:stored="flags"
				:resolved="resolved"
				@toggle-pack="togglePack"
				@toggle-flag="toggleFlag"
			>
				<template #pack-note="{ group }">
					<p
						v-if="group.key === 'marketing' && showProviderNote"
						class="mt-2 flex items-start gap-2 text-sm text-text-secondary"
						data-testid="setup-provider-note"
					>
						<Icon name="lucide:info" class="w-4 h-4 mt-0.5 shrink-0 text-text-tertiary" />
						{{ t('setup.features.providerNote') }}
					</p>
				</template>
			</FeaturePackList>

			<footer class="mt-8 flex items-center justify-between border-t border-border-subtle pt-6">
				<UiButton variant="ghost" @click="router.push('/setup/mode')">
					<template #iconLeft><Icon name="lucide:arrow-left" class="w-4 h-4 mr-2" /></template>
					{{ t('common.back') }}
				</UiButton>
				<UiButton @click="router.push('/setup/email')">
					{{ t('setup.features.next') }}
					<template #iconRight><Icon name="lucide:arrow-right" class="w-4 h-4 ml-2" /></template>
				</UiButton>
			</footer>
		</div>
	</div>
</template>
