<script setup lang="ts">
import {
	SETUP_WIZARD_STEPS,
	SMTP_RELAY_PRESETS,
	buildProviderEnv,
	emailStepIsValid,
	validateEmailStep,
	type EmailStepDraft,
	type ProviderChoice,
	type SmtpPreset,
} from '~/composables/useSetupWizard';

definePageMeta({ layout: false });
useHead({ title: 'Owlat setup — Email provider' });

const router = useRouter();
const { env, requiresProvider, setupToken, goToStep } = useSetupWizard();
const { getStepStatus, isConnectorHighlighted } = useWizard(SETUP_WIZARD_STEPS, 'email');

// Seed the local draft from any previously-entered values so going Back and
// returning doesn't wipe the operator's input.
const initialProvider = (env.value['EMAIL_PROVIDER'] as ProviderChoice | undefined) ?? null;
const provider = ref<ProviderChoice>(initialProvider ?? (requiresProvider.value ? 'mta' : 'none'));
const resendKey = ref(env.value['RESEND_API_KEY'] ?? '');
const sesRegion = ref(env.value['AWS_SES_REGION'] ?? 'us-east-1');
const sesAccess = ref(env.value['AWS_SES_ACCESS_KEY_ID'] ?? '');
const sesSecret = ref(env.value['AWS_SES_SECRET_ACCESS_KEY'] ?? '');
const fromEmail = ref(env.value['DEFAULT_FROM_EMAIL'] ?? '');
const fromName = ref(env.value['DEFAULT_FROM_NAME'] ?? '');

// SMTP relay — seed the preset from a matching known host so returning to the
// step restores what the operator chose, else fall back to Custom.
const initialSmtpHost = env.value['SMTP_RELAY_HOST'] ?? '';
const initialSmtpPreset: SmtpPreset = (() => {
	if (!initialSmtpHost) return 'mailgun';
	const match = (Object.keys(SMTP_RELAY_PRESETS) as SmtpPreset[]).find(
		(p) => p !== 'custom' && SMTP_RELAY_PRESETS[p].host === initialSmtpHost
	);
	return match ?? 'custom';
})();
const smtpPreset = ref<SmtpPreset>(initialSmtpPreset);
const smtpHost = ref(initialSmtpHost || SMTP_RELAY_PRESETS[initialSmtpPreset].host);
const smtpPort = ref(env.value['SMTP_RELAY_PORT'] ?? SMTP_RELAY_PRESETS[initialSmtpPreset].port);
const smtpSecure = ref(
	env.value['SMTP_RELAY_SECURE'] !== undefined
		? env.value['SMTP_RELAY_SECURE'] === 'true'
		: SMTP_RELAY_PRESETS[initialSmtpPreset].secure
);
const smtpUsername = ref(env.value['SMTP_RELAY_USERNAME'] ?? '');
const smtpPassword = ref(env.value['SMTP_RELAY_PASSWORD'] ?? '');

const smtpPresetOptions = (Object.keys(SMTP_RELAY_PRESETS) as SmtpPreset[]).map((key) => ({
	value: key,
	label: SMTP_RELAY_PRESETS[key].label,
}));

// Choosing a named preset prefills host/port/TLS; Custom leaves them editable.
watch(smtpPreset, (preset) => {
	if (preset === 'custom') return;
	const cfg = SMTP_RELAY_PRESETS[preset];
	smtpHost.value = cfg.host;
	smtpPort.value = cfg.port;
	smtpSecure.value = cfg.secure;
});

const submitting = ref(false);
const submitted = ref(false);
const generalError = ref('');

const draft = computed<EmailStepDraft>(() => ({
	provider: provider.value,
	requiresProvider: requiresProvider.value,
	resendKey: resendKey.value,
	ses: { region: sesRegion.value, accessKeyId: sesAccess.value, secretAccessKey: sesSecret.value },
	smtp: {
		preset: smtpPreset.value,
		host: smtpHost.value,
		port: smtpPort.value,
		secure: smtpSecure.value,
		username: smtpUsername.value,
		password: smtpPassword.value,
	},
	fromEmail: fromEmail.value,
	fromName: fromName.value,
}));

// Inline field errors only surface after an advance attempt (or, for the
// optional From address, once the user has typed something into it).
const errors = computed(() => validateEmailStep(draft.value));
const showErrors = computed(() => submitted.value);

// A live provider check (Resend / SMTP) calls a privileged setup endpoint, which
// requires the one-time setup token echoed in the X-Setup-Token header.
const needsLiveCheck = computed(() => provider.value === 'resend' || provider.value === 'smtp');

const providerOptions = computed(() => {
	const base: { value: ProviderChoice; label: string; hint: string; icon: string }[] = [
		{
			value: 'mta',
			label: 'Run your own MTA',
			hint: 'Full control, no third party. Needs port 25 open and a clean sending IP, plus your sending domain + DKIM.',
			icon: 'lucide:server',
		},
		{
			value: 'ses',
			label: 'Amazon SES',
			hint: 'Managed deliverability, cheap at scale. Needs an AWS account.',
			icon: 'lucide:cloud',
		},
		{
			value: 'smtp',
			label: 'SMTP relay',
			hint: 'Bring the provider you already pay for — Mailgun, Postmark, SendGrid, Brevo, or any custom SMTP server.',
			icon: 'lucide:route',
		},
		{
			value: 'resend',
			label: 'Resend',
			hint: 'Managed API with a generous free tier. Great developer experience.',
			icon: 'lucide:zap',
		},
	];
	if (!requiresProvider.value) {
		base.push({
			value: 'none',
			label: 'No delivery provider (receive-only / IMAP-only)',
			hint: 'Read external mailboxes; no marketing or transactional. System/auth email still needs a transport.',
			icon: 'lucide:inbox',
		});
	}
	return base;
});

async function next() {
	submitted.value = true;
	generalError.value = '';
	if (!emailStepIsValid(draft.value)) return;

	// The live provider check authenticates with the one-time setup token; block
	// early with a clear message rather than firing an inevitable 401.
	const token = setupToken.value.trim();
	if (needsLiveCheck.value && token === '') {
		generalError.value =
			'Enter the setup token printed by `owlat setup` to verify the provider, then try again.';
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
		generalError.value = (e as Error).message || 'Could not validate the provider. Try again.';
	} finally {
		submitting.value = false;
	}
}
</script>

<template>
	<div class="min-h-screen bg-bg-base text-text-primary">
		<div class="mx-auto max-w-2xl px-6 py-12">
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
				:on-step-click="goToStep"
			/>

			<header class="mb-6">
				<h1 class="font-display text-3xl mb-2">How should Owlat send mail?</h1>
				<p class="text-text-secondary leading-relaxed">
					Three honest ways to send: run your own mail server for full control, hand delivery to
					Amazon SES, or relay through an SMTP provider you already pay for.
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
							title="A delivery provider is required"
							message="You enabled campaigns, transactional, or automations — these send through a delivery provider, so one is required."
						/>
						<UiErrorAlert
							v-else
							variant="info"
							title="A delivery provider is optional"
							message="No bulk sending is enabled. Note that system/auth emails (password reset, invitations) still need a transport."
						/>
					</div>

					<fieldset class="space-y-2 mb-2">
						<legend class="sr-only">Delivery provider</legend>
						<label
							v-for="opt in providerOptions"
							:key="opt.value"
							class="flex items-start gap-3 rounded-lg border p-4 cursor-pointer transition-colors"
							:class="
								provider === opt.value
									? 'border-brand ring-1 ring-brand bg-brand/5'
									: 'border-border-default hover:border-border-strong'
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
								<div class="font-medium text-text-primary">{{ opt.label }}</div>
								<div class="text-sm text-text-secondary">{{ opt.hint }}</div>
							</div>
						</label>
					</fieldset>
					<p v-if="showErrors && errors.provider" class="text-sm text-error mt-1">
						{{ errors.provider }}
					</p>

					<div v-if="provider === 'resend'" class="mt-5">
						<UiInput
							v-model="resendKey"
							type="password"
							label="Resend API key"
							placeholder="re_..."
							autocomplete="off"
							:error="showErrors ? errors.resendKey : undefined"
						/>
					</div>

					<div v-if="provider === 'ses'" class="mt-5 space-y-4">
						<UiInput v-model="sesRegion" label="Region" placeholder="us-east-1" />
						<UiInput v-model="sesAccess" label="Access key ID" autocomplete="off" />
						<UiInput
							v-model="sesSecret"
							type="password"
							label="Secret access key"
							autocomplete="off"
						/>
						<p v-if="showErrors && errors.ses" class="text-sm text-error">{{ errors.ses }}</p>
					</div>

					<div v-if="provider === 'smtp'" class="mt-5 space-y-4">
						<UiSelect v-model="smtpPreset" label="Provider preset" :options="smtpPresetOptions" />
						<p class="-mt-2 text-sm text-text-tertiary">
							Prefills the server, port, and encryption. Pick Custom for any other SMTP server.
						</p>
						<UiInput
							v-model="smtpHost"
							label="Server host"
							placeholder="smtp.mailgun.org"
							autocomplete="off"
							:disabled="smtpPreset !== 'custom'"
							help-text="The relay handles delivery, so authentication (SPF/DKIM) is set up on the relay's side, not Owlat's."
						/>
						<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
							<UiInput v-model="smtpPort" label="Port" placeholder="587" autocomplete="off" />
							<label
								class="flex items-center gap-3 rounded-lg border border-border-default p-3 cursor-pointer transition-colors hover:border-border-strong"
							>
								<input
									v-model="smtpSecure"
									type="checkbox"
									class="h-4 w-4 rounded border-border-default bg-bg-deep text-brand focus-visible:ring-1 focus-visible:ring-brand"
								/>
								<span class="text-sm text-text-secondary">
									Implicit TLS (port 465). Leave off for STARTTLS on 587.
								</span>
							</label>
						</div>
						<UiInput v-model="smtpUsername" label="Username" autocomplete="off" />
						<UiInput v-model="smtpPassword" type="password" label="Password" autocomplete="off" />
						<p v-if="showErrors && errors.smtp" class="text-sm text-error">{{ errors.smtp }}</p>
					</div>

					<div v-if="provider === 'resend' || provider === 'smtp'" class="mt-5">
						<UiInput
							v-model="setupToken"
							type="password"
							label="Setup token"
							placeholder="stk_…"
							autocomplete="off"
							help-text="Printed by the owlat setup command when it enabled setup mode. Required to verify the provider and launch."
						/>
					</div>

					<div class="mt-6 border-t border-border-subtle pt-6">
						<h2 class="font-medium text-text-primary">
							From identity <span class="text-sm font-normal text-text-tertiary">(optional)</span>
						</h2>
						<p class="text-sm text-text-secondary mb-4">
							The default From address for system mail. Leave blank to derive it from your sending
							domain later.
						</p>
						<div class="space-y-4">
							<UiInput
								v-model="fromEmail"
								type="email"
								label="Default From address"
								placeholder="noreply@yourdomain.com"
								autocomplete="off"
								:error="errors.fromEmail"
								help-text="We'll use this for password resets, invitations, and double opt-in."
							/>
							<UiInput
								v-model="fromName"
								label="From name"
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
					<button type="submit" class="sr-only">Continue</button>
				</form>
			</UiCard>

			<footer class="mt-8 flex items-center justify-between border-t border-border-subtle pt-6">
				<UiButton variant="ghost" :disabled="submitting" @click="router.push('/setup/features')">
					<template #iconLeft><Icon name="lucide:arrow-left" class="w-4 h-4 mr-2" /></template>
					Back
				</UiButton>
				<UiButton :loading="submitting" @click="next">
					{{ submitting ? 'Validating…' : 'Next: Admin account' }}
					<template v-if="!submitting" #iconRight
						><Icon name="lucide:arrow-right" class="w-4 h-4 ml-2"
					/></template>
				</UiButton>
			</footer>
		</div>
	</div>
</template>
