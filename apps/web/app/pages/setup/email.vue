<script setup lang="ts">
import { SETUP_WIZARD_STEPS, buildProviderEnv } from '~/composables/useSetupWizard';
import { emailStepIsValid } from '~/composables/setupWizardValidation';
import { useSetupEmailStepForm } from '~/composables/useSetupEmailStepForm';
import { OUTBOUND_TLS_MODE_OPTIONS } from '~/composables/setupOutboundTls';
import { setupChoiceClass } from '~/utils/setupChoiceCard';
import TransportCredentialFields from '~/components/delivery/TransportCredentialFields.vue';
import { ArrowLeftIcon, ArrowRightIcon, CircleInfoIcon, FeatherIcon } from '@coolicons/vue';

definePageMeta({ layout: false });

const { t } = useI18n();

useHead({ title: () => t('setup.email.pageTitle') });

const router = useRouter();
const { env, flags, requiresProvider, setupToken, goToStep } = useSetupWizard();
const { getStepStatus, isConnectorHighlighted } = useWizard(SETUP_WIZARD_STEPS, 'email');

// `SETUP_WIZARD_STEPS` carries message KEYS (it is built at module scope); the
// indicator renders display text, so resolve them here — as a computed, so the
// labels follow a locale switch instead of freezing at setup.
const displaySteps = computed(() =>
	SETUP_WIZARD_STEPS.map((step) => ({ ...step, label: t(step.label) }))
);

// Field state, the catalog-declared credentials, the transport choice cards and
// the validated draft they add up to — see `useSetupEmailStepForm`.
const {
	provider,
	mtaProfileEnabled,
	transactionalIps,
	campaignIps,
	ehloHostname,
	credentialValues,
	preset,
	presetOptions,
	canValidateLive,
	validateLive,
	fromEmail,
	fromName,
	providerOptions,
	draft,
	errors,
} = useSetupEmailStepForm({ env, flags, requiresProvider });

const submitting = ref(false);
const submitted = ref(false);
const generalError = ref('');

// Inline field errors surface after an advance attempt; the rules module reports
// message keys (an already-translated string passes through `t` unchanged).
const showErrors = computed(() => submitted.value);
function errorText(value: string | undefined): string | undefined {
	return value ? t(value) : undefined;
}

// The selected kind's credential error. Both halves are message keys (the rules
// are pure), and the sentence may name the field it is about.
const credentialError = computed(() => {
	const message = showErrors.value ? errors.value.credentials : undefined;
	return message === undefined ? undefined : t(message.key, { field: t(message.field) });
});

function outboundTlsHint(mode: string): string {
	return OUTBOUND_TLS_MODE_OPTIONS.find((option) => option.value === mode)?.hint ?? '';
}

async function next() {
	submitted.value = true;
	generalError.value = '';
	if (!emailStepIsValid(draft.value)) return;

	// A kind whose catalog entry declares a `setupProbe` is checked live before it
	// is committed, through a privileged setup endpoint that authenticates with the
	// one-time setup token; block early with a clear message rather than firing an
	// inevitable 401.
	const token = setupToken.value.trim();
	if (canValidateLive.value && token === '') {
		generalError.value = t('setup.email.errors.missingToken');
		return;
	}

	submitting.value = true;
	try {
		// Prove the credentials with the provider itself before committing them
		// (an authenticated API call, or a real SMTP handshake), so the operator
		// finds out here rather than at first send.
		const res = await validateLive({
			url: '/api/setup/validate-provider',
			headers: { 'X-Setup-Token': token },
		});
		if (res !== null && !res.ok) {
			generalError.value = res.message;
			return;
		}
		env.value = buildProviderEnv(env.value, draft.value);
		router.push('/setup/admin');
	} catch (e) {
		generalError.value = (e as Error).message || t('setup.email.errors.validationFailed');
	} finally {
		submitting.value = false;
	}
}
</script>

<template>
	<div class="relative isolate min-h-screen overflow-hidden bg-bg-base text-text-primary">
		<UiHeroField />

		<div class="relative mx-auto max-w-3xl px-6 py-12">
			<div class="flex items-center gap-3 mb-8">
				<UiIconBox :icon="FeatherIcon" size="md" variant="brand" rounded="xl" />
				<span class="lp-eyebrow">{{ t('setup.email.eyebrow') }}</span>
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
					keypath="setup.email.title"
					tag="h1"
					scope="global"
					class="text-3xl font-medium tracking-[-0.02em] mb-2"
				>
					<template #accent>
						<span class="lp-title-accent">{{ t('setup.email.titleAccent') }}</span>
					</template>
				</I18nT>
				<p class="text-text-secondary leading-relaxed">
					{{ t('setup.email.intro') }}
				</p>
			</header>

			<UiCard padding="lg">
				<!-- A real <form> so Enter in any credential field advances the step, the
				     same affordance the Admin step already has. -->
				<form @submit.prevent="next">
					<!-- A neutral hint, and only while nothing is picked: once a provider
					     is selected there is nothing left to tell the operator. -->
					<p
						v-if="provider === 'none'"
						class="mb-5 flex items-start gap-2 text-sm text-text-secondary"
						data-testid="setup-provider-hint"
					>
						<CircleInfoIcon class="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary" />
						{{
							requiresProvider
								? t('setup.email.providerRequiredHint')
								: t('setup.email.providerOptionalHint')
						}}
					</p>

					<fieldset class="space-y-2 mb-2">
						<legend class="sr-only">{{ t('setup.email.providerLegend') }}</legend>
						<label
							v-for="opt in providerOptions"
							:key="opt.value"
							class="flex items-start gap-3 p-4 cursor-pointer"
							:class="setupChoiceClass(provider === opt.value)"
						>
							<input
								v-model="provider"
								type="radio"
								:value="opt.value"
								class="mt-1 h-4 w-4 border-border-default bg-bg-deep text-brand focus:ring-brand"
							/>
							<UiIconBox
								:icon="opt.icon"
								size="sm"
								:variant="provider === opt.value ? 'brand' : 'surface'"
								rounded="lg"
							/>
							<div class="flex-1">
								<div class="font-medium text-text-primary">{{ t(opt.label) }}</div>
								<div class="text-sm text-text-secondary">{{ t(opt.hint) }}</div>
							</div>
						</label>
					</fieldset>
					<p v-if="showErrors && errors.provider" class="text-sm text-error mt-1">
						{{ errorText(errors.provider) }}
					</p>

					<!-- The selected kind's catalog credential fields; no per-provider markup.
					     The two notes this step adds are about the relay endpoint FIELD,
					     through the renderer's per-field slot, so they appear wherever a
					     kind declares that field and nowhere else. -->
					<TransportCredentialFields
						v-if="provider !== 'none'"
						class="mt-5"
						:kind="provider"
						:values="credentialValues"
						:preset="preset"
						:preset-options="presetOptions"
						:error="credentialError"
						@update:preset="preset = $event"
					>
						<template #relay>
							<p class="text-sm text-text-tertiary">{{ t('setup.email.smtpPresetHint') }}</p>
							<p class="text-sm text-text-tertiary">{{ t('setup.email.smtpHostHelp') }}</p>
						</template>
						<template #outboundTlsMode="{ value }">
							<p class="text-sm text-text-secondary">{{ t(outboundTlsHint(value)) }}</p>
						</template>
					</TransportCredentialFields>

					<div
						v-if="mtaProfileEnabled"
						class="mt-5 space-y-4 rounded-xl border border-border-subtle p-4"
					>
						<div>
							<h2 class="font-medium text-text-primary">
								{{ t('setup.email.mtaIdentityHeading') }}
							</h2>
							<p class="text-sm text-text-secondary mt-1">
								{{ t('setup.email.mtaIdentityIntro') }}
							</p>
						</div>
						<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
							<UiInput
								v-model="transactionalIps"
								:label="t('setup.email.transactionalIpsLabel')"
								placeholder="203.0.113.10"
								:help-text="t('setup.email.transactionalIpsHelp')"
							/>
							<UiInput
								v-model="campaignIps"
								:label="t('setup.email.campaignIpsLabel')"
								placeholder="203.0.113.11"
								:help-text="t('setup.email.campaignIpsHelp')"
							/>
						</div>
						<UiInput
							v-model="ehloHostname"
							:label="t('setup.email.ehloHostnameLabel')"
							placeholder="mail.example.com"
							:help-text="t('setup.email.ehloHostnameHelp')"
						/>
						<!--
							The PTR record is the one piece of this step that is not a field:
							it is set in the hosting provider's console, by hand, and setup
							refuses to finish without it. Saying so here — rather than only in
							the failure message — is the difference between a five-minute
							detour and an install that dies on "FCrDNS blocked".
						-->
						<div class="rounded-xl border border-border-subtle p-4">
							<h3 class="font-medium text-text-primary">
								{{ t('setup.email.reverseDnsHeading') }}
							</h3>
							<p class="text-sm text-text-secondary mt-1">
								{{ t('setup.email.reverseDnsBody') }}
							</p>
						</div>
						<p v-if="showErrors && errors.mtaIdentity" class="text-sm text-error">
							{{ errorText(errors.mtaIdentity) }}
						</p>
					</div>

					<div v-if="canValidateLive" class="mt-5">
						<UiInput
							v-model="setupToken"
							type="password"
							:label="t('setup.email.setupTokenLabel')"
							placeholder="stk_…"
							autocomplete="off"
							:help-text="t('setup.email.setupTokenHelp')"
						/>
					</div>

					<div class="mt-6 border-t border-border-subtle pt-6">
						<I18nT
							keypath="setup.email.fromIdentityHeading"
							tag="h2"
							scope="global"
							class="font-medium text-text-primary"
						>
							<template #optional>
								<span class="text-sm font-normal text-text-tertiary">{{
									t('setup.email.fromIdentityOptional')
								}}</span>
							</template>
						</I18nT>
						<p class="text-sm text-text-secondary mb-4">
							{{ t('setup.email.fromIdentityIntro') }}
						</p>
						<div class="space-y-4">
							<UiInput
								v-model="fromEmail"
								type="email"
								:label="t('setup.email.fromAddressLabel')"
								:placeholder="t('setup.email.fromAddressPlaceholder')"
								autocomplete="off"
								:error="errorText(errors.fromEmail)"
								:help-text="t('setup.email.fromAddressHelp')"
							/>
							<UiInput
								v-model="fromName"
								:label="t('setup.email.fromNameLabel')"
								placeholder="Owlat"
								autocomplete="off"
							/>
						</div>
					</div>

					<div v-if="generalError" class="mt-5">
						<UiErrorAlert variant="error" :message="generalError" />
					</div>

					<!-- Lets the browser submit the form on Enter; the visible advance
				     control is the footer button below, which calls the same handler. -->
					<button type="submit" class="sr-only">{{ t('common.continue') }}</button>
				</form>
			</UiCard>

			<footer class="mt-8 flex items-center justify-between border-t border-border-subtle pt-6">
				<UiButton variant="ghost" :disabled="submitting" @click="router.push('/setup/features')">
					<template #iconLeft><ArrowLeftIcon class="w-4 h-4 mr-2" /></template>
					{{ t('common.back') }}
				</UiButton>
				<UiButton :loading="submitting" @click="next">
					{{ submitting ? t('setup.email.validating') : t('setup.email.next') }}
					<template v-if="!submitting" #iconRight><ArrowRightIcon class="w-4 h-4 ml-2" /></template>
				</UiButton>
			</footer>
		</div>
	</div>
</template>
