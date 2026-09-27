<script setup lang="ts">
import { SETUP_WIZARD_STEPS } from '~/composables/useSetupWizard';
import { MIN_PASSWORD_LENGTH } from '@owlat/shared/passwordPolicy';
import { validateAdmin, adminIsValid } from '~/composables/setupWizardValidation';

definePageMeta({ layout: false });

const { t } = useI18n();

useHead({ title: () => t('setup.admin.pageTitle') });

const router = useRouter();
const { admin, goToStep } = useSetupWizard();
const { getStepStatus, isConnectorHighlighted } = useWizard(SETUP_WIZARD_STEPS, 'admin');

// `SETUP_WIZARD_STEPS` carries message KEYS (it is built at module scope); the
// indicator renders display text, so resolve them here — as a computed, so the
// labels follow a locale switch instead of freezing at setup.
const displaySteps = computed(() =>
	SETUP_WIZARD_STEPS.map((step) => ({ ...step, label: t(step.label) }))
);

const submitted = ref(false);
// Track touched fields so an error only shows after the user has typed
// something and left the field, or after an advance attempt — never on mount,
// and never while they're still typing. The email field is autofocused, so a
// blur on an untouched, empty field (clicking elsewhere, switching tabs) must
// not paint "Enter a valid email address" before anything was entered.
const touched = reactive({ email: false, password: false });
function markTouched(field: 'email' | 'password') {
	if (admin.value[field] !== '') touched[field] = true;
}

const errors = computed(() => validateAdmin(admin.value));
// The rules module is pure, so its fields carry message keys (see the i18n
// registry convention); an already-translated string passes through unchanged.
const emailError = computed(() =>
	(submitted.value || touched.email) && errors.value.email ? t(errors.value.email) : undefined
);
const passwordError = computed(() =>
	(submitted.value || touched.password) && errors.value.password
		? t(errors.value.password, { min: MIN_PASSWORD_LENGTH })
		: undefined
);

function next() {
	submitted.value = true;
	if (!adminIsValid(admin.value)) return;
	router.push('/setup/review');
}
</script>

<template>
	<div class="relative isolate min-h-screen overflow-hidden bg-bg-base text-text-primary">
		<UiHeroField />

		<div class="relative mx-auto max-w-3xl px-6 py-12">
			<div class="flex items-center gap-3 mb-8">
				<UiIconBox icon="lucide:feather" size="md" variant="brand" rounded="xl" />
				<span class="lp-eyebrow">{{ t('setup.admin.eyebrow') }}</span>
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
					keypath="setup.admin.title"
					tag="h1"
					scope="global"
					class="text-3xl font-medium tracking-[-0.02em] mb-2"
				>
					<template #accent>
						<span class="lp-title-accent">{{ t('setup.admin.titleAccent') }}</span>
					</template>
				</I18nT>
				<p class="text-text-secondary leading-relaxed">
					{{ t('setup.admin.intro') }}
				</p>
			</header>

			<UiCard padding="lg">
				<form class="space-y-5" @submit.prevent="next">
					<UiInput
						v-model="admin.email"
						type="email"
						:label="t('common.email')"
						:placeholder="t('auth.fields.emailPlaceholder')"
						autocomplete="email"
						autofocus
						required
						:error="emailError"
						@blur="markTouched('email')"
					/>
					<UiInput
						v-model="admin.name"
						:label="t('setup.admin.displayName')"
						:placeholder="t('setup.admin.displayNamePlaceholder')"
						autocomplete="name"
					/>
					<AuthPasswordInput
						v-model="admin.password"
						:label="t('auth.fields.password')"
						autocomplete="new-password"
						required
						:error="passwordError"
						:help-text="t('auth.fields.passwordHelp', { min: MIN_PASSWORD_LENGTH })"
						@blur="markTouched('password')"
					/>
				</form>
			</UiCard>

			<footer class="mt-8 flex items-center justify-between border-t border-border-subtle pt-6">
				<UiButton variant="ghost" @click="router.push('/setup/email')">
					<template #iconLeft><Icon name="lucide:arrow-left" class="w-4 h-4 mr-2" /></template>
					{{ t('common.back') }}
				</UiButton>
				<UiButton @click="next">
					{{ t('setup.admin.next') }}
					<template #iconRight><Icon name="lucide:arrow-right" class="w-4 h-4 ml-2" /></template>
				</UiButton>
			</footer>
		</div>
	</div>
</template>
