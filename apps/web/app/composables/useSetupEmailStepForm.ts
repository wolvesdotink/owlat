/**
 * THE EMAIL STEP'S FORM MODEL — every field the "How should Owlat send mail?"
 * screen edits, seeded from the wizard's collected `env`, plus the derived draft
 * the step's pure rules validate.
 *
 * The step page owns the submit flow (the live provider check, the env commit
 * and the navigation); this composable owns the state that flow reads. Splitting
 * them the way `setupWizardValidation` and `setupOutboundTls` were split out of
 * `useSetupWizard` keeps the page a form and its file under the size ratchet.
 *
 * Everything here is seeded from prior values, so navigating back to this step
 * never wipes operator input, and the option lists carry message KEYS (the i18n
 * registry convention) because they are declared at module scope — the page
 * resolves them with `t()` where it renders.
 */

import type { ComputedRef, Ref } from 'vue';
import { getActiveProfiles, type FeatureFlagState } from '@owlat/shared/featureFlags';
import {
	SMTP_RELAY_PRESETS,
	type EmailStepDraft,
	type ProviderChoice,
	type SmtpPreset,
} from './useSetupWizard';
import { validateEmailStep } from './setupWizardValidation';

/** One delivery-transport choice card: message keys plus its icon. */
export interface ProviderOption {
	value: ProviderChoice;
	/** MESSAGE KEY for the transport's name. */
	label: string;
	/** MESSAGE KEY for the one-line description under it. */
	hint: string;
	icon: string;
}

/**
 * The transport choice cards, in the order they are offered. "No email for now"
 * is last because it is only offered at all when no enabled feature needs a
 * delivery provider — see {@link useSetupEmailStepForm}.
 */
const PROVIDER_OPTIONS: ProviderOption[] = [
	{
		value: 'mta',
		label: 'setup.email.providers.mta.label',
		hint: 'setup.email.providers.mta.hint',
		icon: 'lucide:server',
	},
	{
		value: 'ses',
		label: 'setup.email.providers.ses.label',
		hint: 'setup.email.providers.ses.hint',
		icon: 'lucide:cloud',
	},
	{
		value: 'smtp',
		label: 'setup.email.providers.smtp.label',
		hint: 'setup.email.providers.smtp.hint',
		icon: 'lucide:route',
	},
	{
		value: 'resend',
		label: 'setup.email.providers.resend.label',
		hint: 'setup.email.providers.resend.hint',
		icon: 'lucide:zap',
	},
	{
		value: 'mandrill',
		label: 'setup.email.providers.mandrill.label',
		hint: 'setup.email.providers.mandrill.hint',
		icon: 'lucide:shuffle',
	},
	{
		value: 'emailit',
		label: 'setup.email.providers.emailit.label',
		hint: 'setup.email.providers.emailit.hint',
		icon: 'lucide:send',
	},
	{
		value: 'none',
		label: 'setup.email.providers.none.label',
		hint: 'setup.email.providers.none.hint',
		icon: 'lucide:inbox',
	},
];

/**
 * Vendor names from the shared preset table (`@owlat/shared`, also read by the
 * setup CLI): not app copy, so they are rendered as the table spells them.
 */
const SMTP_PRESET_OPTIONS = (Object.keys(SMTP_RELAY_PRESETS) as SmtpPreset[]).map((key) => ({
	value: key,
	label: SMTP_RELAY_PRESETS[key].label,
}));

/**
 * Restore a matching relay preset from a previously-entered host, otherwise fall
 * back to Custom (an unrecognised host is one the operator typed themselves).
 */
export function resolveSmtpPreset(host: string): SmtpPreset {
	if (!host) return 'mailgun';
	const match = (Object.keys(SMTP_RELAY_PRESETS) as SmtpPreset[]).find(
		(p) => p !== 'custom' && SMTP_RELAY_PRESETS[p].host === host
	);
	return match ?? 'custom';
}

export function useSetupEmailStepForm(wizard: {
	/** The wizard's collected env — the seed for every field below. */
	env: Ref<Record<string, string>>;
	flags: Ref<FeatureFlagState>;
	/** True when an enabled feature needs a delivery provider (no opt-out). */
	requiresProvider: Ref<boolean> | ComputedRef<boolean>;
}) {
	const { env, flags, requiresProvider } = wizard;

	// Seed from prior values so navigating back does not wipe operator input.
	const initialProvider = (env.value['EMAIL_PROVIDER'] as ProviderChoice | undefined) ?? null;
	const provider = ref<ProviderChoice>(
		initialProvider ?? (requiresProvider.value ? 'mta' : 'none')
	);
	const mtaProfileEnabled = computed(() =>
		getActiveProfiles(flags.value, { deliveryProvider: provider.value }).includes('mta')
	);
	const transactionalIps = ref(env.value['IP_POOLS_TRANSACTIONAL'] ?? '');
	const campaignIps = ref(env.value['IP_POOLS_CAMPAIGN'] ?? '');
	const ehloHostname = ref(env.value['EHLO_HOSTNAME'] ?? '');
	const ehloHostnames = ref(env.value['EHLO_HOSTNAMES'] ?? '');
	const resendKey = ref(env.value['RESEND_API_KEY'] ?? '');
	const emailitKey = ref(env.value['EMAILIT_API_KEY'] ?? '');
	const mandrillKey = ref(env.value['MANDRILL_API_KEY'] ?? '');
	const sesRegion = ref(env.value['AWS_SES_REGION'] ?? 'us-east-1');
	const sesAccess = ref(env.value['AWS_SES_ACCESS_KEY_ID'] ?? '');
	const sesSecret = ref(env.value['AWS_SES_SECRET_ACCESS_KEY'] ?? '');
	const fromEmail = ref(env.value['DEFAULT_FROM_EMAIL'] ?? '');
	const fromName = ref(env.value['DEFAULT_FROM_NAME'] ?? '');

	const initialSmtpHost = env.value['SMTP_RELAY_HOST'] ?? '';
	const initialSmtpPreset = resolveSmtpPreset(initialSmtpHost);
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

	watch(smtpPreset, (preset) => {
		if (preset === 'custom') return;
		const cfg = SMTP_RELAY_PRESETS[preset];
		smtpHost.value = cfg.host;
		smtpPort.value = cfg.port;
		smtpSecure.value = cfg.secure;
	});

	// "No email for now" is only a choice when nothing enabled needs a provider.
	const providerOptions = computed(() =>
		requiresProvider.value
			? PROVIDER_OPTIONS.filter((option) => option.value !== 'none')
			: PROVIDER_OPTIONS
	);

	const draft = computed<EmailStepDraft>(() => ({
		provider: provider.value,
		requiresProvider: requiresProvider.value,
		resendKey: resendKey.value,
		emailitKey: emailitKey.value,
		mandrillKey: mandrillKey.value,
		ses: {
			region: sesRegion.value,
			accessKeyId: sesAccess.value,
			secretAccessKey: sesSecret.value,
		},
		smtp: {
			preset: smtpPreset.value,
			host: smtpHost.value,
			port: smtpPort.value,
			secure: smtpSecure.value,
			username: smtpUsername.value,
			password: smtpPassword.value,
		},
		mtaProfileEnabled: mtaProfileEnabled.value,
		mtaIdentity: {
			transactionalIps: transactionalIps.value,
			campaignIps: campaignIps.value,
			ehloHostname: ehloHostname.value,
			ehloHostnames: ehloHostnames.value,
		},
		fromEmail: fromEmail.value,
		fromName: fromName.value,
	}));

	// The rules module is pure, so its fields carry message keys; the page
	// resolves them (an already-translated string passes through `t` unchanged).
	const errors = computed(() => validateEmailStep(draft.value));

	return {
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
		smtpPresetOptions: SMTP_PRESET_OPTIONS,
		providerOptions,
		draft,
		errors,
	};
}
