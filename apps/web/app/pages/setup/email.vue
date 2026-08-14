<script setup lang="ts">
import { SETUP_WIZARD_STEPS, buildProviderEnv } from '~/composables/useSetupWizard';
import { emailStepIsValid } from '~/composables/setupWizardValidation';
import { useSetupEmailStepForm } from '~/composables/useSetupEmailStepForm';

definePageMeta({ layout: false });

const { t } = useI18n();

useHead({ title: () => t('setup.email.pageTitle') });

const router = useRouter();
const { env, flags, requiresProvider, setupToken, goToStep } = useSetupWizard();
const { getStepStatus, isConnectorHighlighted } = useWizard(SETUP_WIZARD_STEPS, 'email');

// Field state, the SMTP relay presets, the transport choice cards and the
// validated draft they add up to — see `useSetupEmailStepForm`.
const {
	provider,
	mtaProfileEnabled,
	transactionalIps,
	campaignIps,
	ehloHostname,
	ehloHostnames,
	resendKey,
	emailitKey,
	mandrillKey,
	sesRegion,
	sesAccess,
	sesSecret,
	fromEmail,
	fromName,
	smtpPreset,
	smtpHost,
	smtpPort,
	smtpSecure,
	smtpUsername,
	smtpPassword,
	smtpPresetOptions,
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

// A live provider check (Resend / SMTP) calls a privileged setup endpoint, which
// requires the one-time setup token echoed in the X-Setup-Token header.
const needsLiveCheck = computed(() => ['resend', 'emailit', 'smtp'].includes(provider.value));

async function next() {
	submitted.value = true;
	generalError.value = '';
	if (!emailStepIsValid(draft.value)) return;

	// The live provider check authenticates with the one-time setup token; block
	// early with a clear message rather than firing an inevitable 401.
	const token = setupToken.value.trim();
	if (needsLiveCheck.value && token === '') {
		generalError.value = t('setup.email.errors.missingToken');
		return;
	}
	const setupHeaders = { 'X-Setup-Token': token };

	submitting.value = true;
	try {
		// Validate a Resend key against the live API before committing it, so the
		// operator finds out here rather than at first send.
		if (provider.value === 'resend') {
			const res = await $fetch<{ ok: boolean; message: string }>('/api/setup/validate-provider', {
				method: 'POST',
				headers: setupHeaders,
				body: { provider: 'resend', apiKey: resendKey.value },
			});
			if (!res.ok) {
				generalError.value = res.message;
				return;
			}
		}
		if (provider.value === 'emailit') {
			const res = await $fetch<{ ok: boolean; message: string }>('/api/setup/validate-provider', {
				method: 'POST',
				headers: setupHeaders,
				body: { provider: 'emailit', apiKey: emailitKey.value },
			});
			if (!res.ok) {
				generalError.value = res.message;
				return;
			}
		}
		// Prove the SMTP relay is reachable and the credentials authenticate with a
		// real handshake, so a wrong host/port/password is caught here, not at send.
		if (provider.value === 'smtp') {
			const trimmedPort = smtpPort.value.trim();
			const res = await $fetch<{ ok: boolean; message: string }>('/api/setup/validate-provider', {
				method: 'POST',
				headers: setupHeaders,
				body: {
					provider: 'smtp',
					smtp: {
						host: smtpHost.value.trim(),
						port: trimmedPort ? Number.parseInt(trimmedPort, 10) : 587,
						secure: smtpSecure.value,
						username: smtpUsername.value,
						password: smtpPassword.value,
					},
				},
			});
			if (!res.ok) {
				generalError.value = res.message;
				return;
			}
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

		<div class="relative mx-auto max-w-2xl px-6 py-12">
			<div class="flex items-center gap-3 mb-8">
				<UiIconBox icon="lucide:feather" size="md" variant="brand" rounded="xl" />
				<span class="lp-eyebrow">{{ t('setup.email.eyebrow') }}</span>
			</div>

			<UiStepIndicator
				class="mb-10"
				:steps="SETUP_WIZARD_STEPS"
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
					<div class="mb-5">
						<UiErrorAlert
							v-if="requiresProvider"
							variant="info"
							:title="t('setup.email.providerRequiredTitle')"
							:message="t('setup.email.providerRequiredMessage')"
						/>
						<UiErrorAlert
							v-else
							variant="info"
							:title="t('setup.email.providerOptionalTitle')"
							:message="t('setup.email.providerOptionalMessage')"
						/>
					</div>

					<fieldset class="space-y-2 mb-2">
						<legend class="sr-only">{{ t('setup.email.providerLegend') }}</legend>
						<label
							v-for="opt in providerOptions"
							:key="opt.value"
							class="flex items-start gap-3 rounded-xl border p-4 cursor-pointer transition-[border-color,background-color,box-shadow] duration-(--motion-fast) ease-spring"
							:class="
								provider === opt.value
									? 'border-brand shadow-surface-2 bg-brand-soft'
									: 'border-transparent bg-surface-1 shadow-surface-1 hover:shadow-surface-2'
							"
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

					<div v-if="provider === 'resend'" class="mt-5">
						<UiInput
							v-model="resendKey"
							type="password"
							:label="t('setup.email.resendKeyLabel')"
							placeholder="re_..."
							autocomplete="off"
							:error="showErrors ? errorText(errors.resendKey) : undefined"
						/>
					</div>

					<div v-if="provider === 'emailit'" class="mt-5">
						<UiInput
							v-model="emailitKey"
							type="password"
							:label="t('setup.email.emailitKeyLabel')"
							placeholder="em_..."
							autocomplete="off"
							:error="showErrors ? errorText(errors.emailitKey) : undefined"
						/>
					</div>

					<div v-if="provider === 'mandrill'" class="mt-5 space-y-3">
						<UiInput
							v-model="mandrillKey"
							type="password"
							:label="t('setup.email.mandrillKeyLabel')"
							placeholder="md-..."
							autocomplete="off"
							:error="showErrors ? errorText(errors.mandrillKey) : undefined"
						/>
						<p class="text-xs text-text-tertiary">
							{{ t('setup.email.mandrillHint') }}
						</p>
					</div>

					<div v-if="provider === 'ses'" class="mt-5 space-y-4">
						<UiInput
							v-model="sesRegion"
							:label="t('setup.email.sesRegionLabel')"
							placeholder="us-east-1"
						/>
						<UiInput
							v-model="sesAccess"
							:label="t('setup.email.sesAccessKeyLabel')"
							autocomplete="off"
						/>
						<UiInput
							v-model="sesSecret"
							type="password"
							:label="t('setup.email.sesSecretKeyLabel')"
							autocomplete="off"
						/>
						<p v-if="showErrors && errors.ses" class="text-sm text-error">
							{{ errorText(errors.ses) }}
						</p>
					</div>

					<div v-if="provider === 'smtp'" class="mt-5 space-y-4">
						<UiSelect
							v-model="smtpPreset"
							:label="t('setup.email.smtpPresetLabel')"
							:options="smtpPresetOptions"
						/>
						<p class="-mt-2 text-sm text-text-tertiary">
							{{ t('setup.email.smtpPresetHint') }}
						</p>
						<UiInput
							v-model="smtpHost"
							:label="t('setup.email.smtpHostLabel')"
							placeholder="smtp.mailgun.org"
							autocomplete="off"
							:disabled="smtpPreset !== 'custom'"
							:help-text="t('setup.email.smtpHostHelp')"
						/>
						<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
							<UiInput
								v-model="smtpPort"
								:label="t('setup.email.smtpPortLabel')"
								placeholder="587"
								autocomplete="off"
							/>
							<label
								class="flex items-center gap-3 rounded-xl bg-surface-1 shadow-surface-1 border border-transparent p-3 cursor-pointer transition-[box-shadow] duration-(--motion-fast) ease-spring hover:shadow-surface-2"
							>
								<input
									v-model="smtpSecure"
									type="checkbox"
									class="h-4 w-4 rounded border-border-default bg-bg-deep text-brand focus-visible:ring-1 focus-visible:ring-brand"
								/>
								<span class="text-sm text-text-secondary">
									{{ t('setup.email.smtpSecureLabel') }}
								</span>
							</label>
						</div>
						<UiInput
							v-model="smtpUsername"
							:label="t('setup.email.smtpUsernameLabel')"
							autocomplete="off"
						/>
						<UiInput
							v-model="smtpPassword"
							type="password"
							:label="t('auth.fields.password')"
							autocomplete="off"
						/>
						<p v-if="showErrors && errors.smtp" class="text-sm text-error">
							{{ errorText(errors.smtp) }}
						</p>
					</div>

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
						<UiInput
							v-model="ehloHostnames"
							:label="t('setup.email.ehloOverridesLabel')"
							placeholder='{"203.0.113.11":"mail2.example.com"}'
							:help-text="t('setup.email.ehloOverridesHelp')"
						/>
						<p v-if="showErrors && errors.mtaIdentity" class="text-sm text-error">
							{{ errorText(errors.mtaIdentity) }}
						</p>
					</div>

					<div v-if="provider === 'resend' || provider === 'smtp'" class="mt-5">
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
					<template #iconLeft><Icon name="lucide:arrow-left" class="w-4 h-4 mr-2" /></template>
					{{ t('common.back') }}
				</UiButton>
				<UiButton :loading="submitting" @click="next">
					{{ submitting ? t('setup.email.validating') : t('setup.email.next') }}
					<template v-if="!submitting" #iconRight
						><Icon name="lucide:arrow-right" class="w-4 h-4 ml-2"
					/></template>
				</UiButton>
			</footer>
		</div>
	</div>
</template>
