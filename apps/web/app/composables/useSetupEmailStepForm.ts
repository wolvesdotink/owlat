/**
 * THE EMAIL STEP'S FORM MODEL — every field the "How should Owlat send mail?"
 * screen edits, seeded from the wizard's collected `env`, plus the derived draft
 * the step's pure rules validate.
 *
 * The step page owns the submit flow (the live provider check, the env commit
 * and the navigation); this composable owns the state that flow reads.
 *
 * THE CREDENTIALS ARE THE CATALOG'S. They live in the shared relay draft
 * (`useRelayCredentialDraft`) as one map keyed by env variable, seeded from the
 * selected entry's `credentialFields` descriptors and from the collected `env`,
 * and the page renders them with `TransportCredentialFields.vue` — so a kind's
 * fields, defaults, required flags and pre-apply probe are declared once, in its
 * catalog entry, and this step has no per-vendor field of its own. Splitting
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
import type { EmailStepDraft, ProviderChoice } from './useSetupWizard';
import { validateEmailStep } from './setupWizardValidation';
import { useRelayCredentialDraft } from './useRelayCredentialDraft';
import {
	CloudIcon,
	InboxIcon,
	PaperPlaneIcon,
	RouteIcon,
	ServerIcon,
	ShuffleIcon,
	ZapIcon,
	type IconComponent,
} from '@coolicons/vue';

/** One delivery-transport choice card: message keys plus its icon. */
export interface ProviderOption {
	value: ProviderChoice;
	/** MESSAGE KEY for the transport's name. */
	label: string;
	/** MESSAGE KEY for the one-line description under it. */
	hint: string;
	icon: IconComponent;
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
		icon: ServerIcon,
	},
	{
		value: 'ses',
		label: 'setup.email.providers.ses.label',
		hint: 'setup.email.providers.ses.hint',
		icon: CloudIcon,
	},
	{
		value: 'smtp',
		label: 'setup.email.providers.smtp.label',
		hint: 'setup.email.providers.smtp.hint',
		icon: RouteIcon,
	},
	{
		value: 'resend',
		label: 'setup.email.providers.resend.label',
		hint: 'setup.email.providers.resend.hint',
		icon: ZapIcon,
	},
	{
		value: 'mandrill',
		label: 'setup.email.providers.mandrill.label',
		hint: 'setup.email.providers.mandrill.hint',
		icon: ShuffleIcon,
	},
	{
		value: 'emailit',
		label: 'setup.email.providers.emailit.label',
		hint: 'setup.email.providers.emailit.hint',
		icon: PaperPlaneIcon,
	},
	{
		value: 'none',
		label: 'setup.email.providers.none.label',
		hint: 'setup.email.providers.none.hint',
		icon: InboxIcon,
	},
];

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
	const transactionalIps = ref(env.value['IP_POOLS_TRANSACTIONAL'] ?? '');
	const campaignIps = ref(env.value['IP_POOLS_CAMPAIGN'] ?? '');
	const ehloHostname = ref(env.value['EHLO_HOSTNAME'] ?? '');
	const fromEmail = ref(env.value['DEFAULT_FROM_EMAIL'] ?? '');
	const fromName = ref(env.value['DEFAULT_FROM_NAME'] ?? '');

	// Seeded from the collected env, so navigating back keeps every credential the
	// operator typed — for the selected kind and for any kind they switched away
	// from — and the relay endpoint's preset is the one its saved host matches.
	const relay = useRelayCredentialDraft(
		initialProvider ?? (requiresProvider.value ? 'mta' : 'none'),
		env.value
	);
	const { provider, credentialValues, preset, presetOptions, canValidateLive } = relay;
	const mtaProfileEnabled = computed(() =>
		getActiveProfiles(flags.value, { deliveryProvider: provider.value }).includes('mta')
	);

	// "No email for now" is only a choice when nothing enabled needs a provider.
	const providerOptions = computed(() =>
		requiresProvider.value
			? PROVIDER_OPTIONS.filter((option) => option.value !== 'none')
			: PROVIDER_OPTIONS
	);

	const draft = computed<EmailStepDraft>(() => ({
		provider: provider.value,
		requiresProvider: requiresProvider.value,
		credentials: { ...credentialValues },
		mtaProfileEnabled: mtaProfileEnabled.value,
		mtaIdentity: {
			transactionalIps: transactionalIps.value,
			campaignIps: campaignIps.value,
			ehloHostname: ehloHostname.value,
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
		credentialValues,
		preset,
		presetOptions,
		canValidateLive,
		validateLive: relay.validateLive,
		fromEmail,
		fromName,
		providerOptions,
		draft,
		errors,
	};
}
