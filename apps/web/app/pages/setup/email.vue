<script setup lang="ts">
import {
	SETUP_WIZARD_STEPS,
	buildProviderEnv,
	emailStepIsValid,
	validateEmailStep,
	type EmailStepDraft,
	type ProviderChoice,
} from '~/composables/useSetupWizard';

definePageMeta({ layout: false });
useHead({ title: 'Owlat setup — Email provider' });

const router = useRouter();
const { env, requiresProvider } = useSetupWizard();
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

const submitting = ref(false);
const submitted = ref(false);
const generalError = ref('');

const draft = computed<EmailStepDraft>(() => ({
	provider: provider.value,
	requiresProvider: requiresProvider.value,
	resendKey: resendKey.value,
	ses: { region: sesRegion.value, accessKeyId: sesAccess.value, secretAccessKey: sesSecret.value },
	fromEmail: fromEmail.value,
	fromName: fromName.value,
}));

// Inline field errors only surface after an advance attempt (or, for the
// optional From address, once the user has typed something into it).
const errors = computed(() => validateEmailStep(draft.value));
const showErrors = computed(() => submitted.value);

const providerOptions = computed(() => {
	const base: { value: ProviderChoice; label: string; hint: string; icon: string }[] = [
		{ value: 'mta', label: 'Owlat MTA (self-hosted)', hint: 'No third-party. Needs sending domain + DKIM.', icon: 'lucide:server' },
		{ value: 'resend', label: 'Resend', hint: 'Best DX, free tier available.', icon: 'lucide:zap' },
		{ value: 'ses', label: 'Amazon SES', hint: 'Cheap at scale, requires an AWS account.', icon: 'lucide:cloud' },
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

	submitting.value = true;
	try {
		// Validate a Resend key against the live API before committing it, so the
		// operator finds out here rather than at first send.
		if (provider.value === 'resend') {
			const res = await $fetch<{ ok: boolean; message: string }>('/api/setup/validate-provider', {
				method: 'POST',
				body: { provider: 'resend', apiKey: resendKey.value },
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
				<h1 class="font-display text-3xl mb-2">Email provider</h1>
				<p class="text-text-secondary leading-relaxed">How should Owlat send mail?</p>
			</header>

			<UiCard padding="lg">
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
						:class="provider === opt.value ? 'border-brand ring-1 ring-brand bg-brand/5' : 'border-border-default hover:border-border-strong'"
					>
						<input v-model="provider" type="radio" :value="opt.value" class="mt-1 h-4 w-4 border-border-default bg-bg-deep text-brand focus:ring-brand" />
						<UiIconBox :icon="opt.icon" size="sm" :variant="provider === opt.value ? 'brand' : 'surface'" rounded="lg" />
						<div class="flex-1">
							<div class="font-medium text-text-primary">{{ opt.label }}</div>
							<div class="text-sm text-text-secondary">{{ opt.hint }}</div>
						</div>
					</label>
				</fieldset>
				<p v-if="showErrors && errors.provider" class="text-sm text-error mt-1">{{ errors.provider }}</p>

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
					<UiInput v-model="sesSecret" type="password" label="Secret access key" autocomplete="off" />
					<p v-if="showErrors && errors.ses" class="text-sm text-error">{{ errors.ses }}</p>
				</div>

				<div class="mt-6 border-t border-border-subtle pt-6">
					<h2 class="font-medium text-text-primary">From identity <span class="text-sm font-normal text-text-tertiary">(optional)</span></h2>
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
						<UiInput v-model="fromName" label="From name" placeholder="Owlat" autocomplete="off" />
					</div>
				</div>

				<div v-if="generalError" class="mt-5">
					<UiErrorAlert variant="error" :message="generalError" />
				</div>
			</UiCard>

			<footer class="mt-8 flex items-center justify-between border-t border-border-subtle pt-6">
				<UiButton variant="ghost" :disabled="submitting" @click="router.push('/setup/features')">
					<template #iconLeft><Icon name="lucide:arrow-left" class="w-4 h-4 mr-2" /></template>
					Back
				</UiButton>
				<UiButton :loading="submitting" @click="next">
					{{ submitting ? 'Validating…' : 'Next: Admin account' }}
					<template v-if="!submitting" #iconRight><Icon name="lucide:arrow-right" class="w-4 h-4 ml-2" /></template>
				</UiButton>
			</footer>
		</div>
	</div>
</template>
