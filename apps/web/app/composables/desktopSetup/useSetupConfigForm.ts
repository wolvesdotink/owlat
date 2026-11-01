/**
 * The desktop setup wizard's Configure step: feature packs, the sending
 * provider, AI, the domain with its hostname labels, and the admin account,
 * stepped through with the shared wizard, then validated and turned into the
 * setup config the installer reads.
 */
import type { Ref } from 'vue';
import {
	deriveHostnames,
	networkUrlsFromHosts,
	defaultSubdomainLabels,
	validateSubdomainLabels,
	SUBDOMAIN_KEYS,
	type InstanceHostnames,
	type SendingConfig,
	type SetupConfigInput,
	type SubdomainKey,
	type SubdomainLabels,
} from '~/lib/desktop/provisioning';
import { assessPassword, validateAdminPassword } from '~/lib/desktop/provisioningForm';
import type { FeaturePackKey } from '@owlat/shared/featureFlags';
import { OWN_SEND_PROVIDER_KIND, isOwnSendProviderKind } from '@owlat/shared/sendProviderCatalog';
import {
	SETUP_SENDING_CATALOG_ENTRIES,
	isSetupSendingKind,
	sendingConfigFromCredentials,
	type SendingCredentialProblem,
} from '@owlat/shared/setupSendingConfig';
import { useLocalized } from '~/composables/useLocalized';
import { useRelayCredentialDraft } from '~/composables/useRelayCredentialDraft';
import { OUTBOUND_TLS_MODE_OPTIONS } from '~/composables/setupOutboundTls';

// ---- configure wizard steps ----
const configSteps = [
	{ id: 'features', label: 'desktop.setup.steps.features', icon: 'lucide:blocks' },
	{ id: 'providers', label: 'desktop.setup.steps.providers', icon: 'lucide:plug' },
	{ id: 'domain', label: 'desktop.setup.steps.domain', icon: 'lucide:globe' },
	{ id: 'admin', label: 'desktop.setup.steps.admin', icon: 'lucide:user-cog' },
] as const;
export type ConfigStep = (typeof configSteps)[number]['id'];

export function useSetupConfigForm(options: {
	/** The SSH host is not this machine, so the install needs a public domain. */
	isRemoteTarget: Readonly<Ref<boolean>>;
	/** The public IP read over the SSH session, when it could be. */
	detectedPublicIp: Readonly<Ref<string>>;
	provision: (config: SetupConfigInput) => Promise<void>;
}) {
	const { isRemoteTarget, detectedPublicIp, provision } = options;
	const { t } = useI18n();
	// Registry-supplied copy (password assessment) arrives as a message key.
	const tk = useLocalized();

	// Keyed by the shared pack vocabulary, so a misspelled pack is a compile error
	// here rather than a `parseSetupConfig` rejection on the server.
	const packs = reactive<Record<FeaturePackKey, boolean>>({
		emailClient: true,
		marketing: true,
		ai: false,
	});
	const packOptions: ReadonlyArray<{ key: FeaturePackKey; label: string }> = [
		{ key: 'emailClient', label: 'desktop.setup.packs.emailClient' },
		{ key: 'marketing', label: 'desktop.setup.packs.marketing' },
		{ key: 'ai', label: 'desktop.setup.packs.ai' },
	];
	/**
	 * Sending provider + credentials. The picker lists every catalog kind the setup
	 * config can carry, the credential form is the catalog's own descriptor renderer
	 * (shared with the in-app transport editor), and `sendingConfigFromCredentials`
	 * turns the entered values into the config's `sending` block. No provider is
	 * named on this page.
	 */
	const {
		provider: sendingProvider,
		credentialValues: sendingCredentials,
		preset: sendingPreset,
		presetOptions: sendingPresetOptions,
	} = useRelayCredentialDraft(OWN_SEND_PROVIDER_KIND);
	/** The own MTA is named as an instruction; a relay by its catalog label. */
	const sendingOptions = computed(() =>
		SETUP_SENDING_CATALOG_ENTRIES.map((entry) => ({
			value: entry.kind,
			label: isOwnSendProviderKind(entry.kind) ? t('desktop.setup.sending.mta') : entry.label,
		}))
	);
	/** Mail/bounce hostnames, their DNS records and the deliverability hint are the own MTA's. */
	const usesOwnMta = computed(() => isOwnSendProviderKind(sendingProvider.value));
	function outboundTlsHint(mode: string): string {
		return OUTBOUND_TLS_MODE_OPTIONS.find((option) => option.value === mode)?.hint ?? '';
	}
	function sendingProblemMessage({ field, reason }: SendingCredentialProblem): string {
		if (reason === 'missing') {
			return t('shared.setupWizardCredentials.enterField', { field: t(field.label) });
		}
		if (field.kind === 'host-port') {
			return t('desktop.setup.errors.portInvalid', { port: field.portDefault });
		}
		return t('desktop.setup.errors.fieldInvalid', { field: t(field.label) });
	}
	const aiProvider = ref<'none' | 'openrouter' | 'openai' | 'ollama'>('none');
	const aiKey = ref('');
	const adminEmail = ref('');
	const adminName = ref('');
	const adminPassword = ref('');
	const adminPasswordConfirm = ref('');
	const revealPassword = ref(false);
	/** Live length + strength read-out shown as the admin password is typed. */
	const passwordAssessment = computed(() => assessPassword(adminPassword.value));
	/**
	 * Inline password error shown live (before submit). Stays quiet until the user
	 * has started typing both fields so the form doesn't shout on first render.
	 */
	const adminPasswordError = computed(() => {
		if (!adminPassword.value && !adminPasswordConfirm.value) return null;
		return validateAdminPassword(adminPassword.value, adminPasswordConfirm.value).error;
	});
	// One apex domain (e.g. wolves.ink) populates every hostname; the per-host
	// overrides below are blank unless the user customises them.
	const domain = ref('');
	// When connected by hostname we don't know the server's public IP — the wizard
	// auto-detects it over the live SSH session (see `detectedPublicIp`), but the
	// operator can still override it here if detection failed or was wrong.
	const publicIp = ref('');
	// Prefill the manual-paste field with the value auto-detected over SSH, unless
	// the operator has already typed one (never clobber their input, and fail-soft:
	// an empty detection leaves the field blank for manual entry).
	watch(detectedPublicIp, (detected) => {
		if (detected && !publicIp.value) publicIp.value = detected;
	});
	// The five subdomain labels (owlat / api / rest.api / mail / bounce), prefilled
	// with their defaults and edited through the "customize hostnames" disclosure.
	// They flow through deriveHostnames() — the single place labels become
	// hostnames — so an override can't drift across the DNS records, generated
	// config and network URLs.
	//
	// The disclosure deliberately overrides the LABEL, not a full hostname: the
	// whole wizard is built around one apex domain (the domain field, the DNS
	// record table, SPF coexistence and A-record IP detection all assume it), so a
	// cross-apex hostname (e.g. app.other-domain.com) would need per-host DNS
	// guidance the wizard doesn't model. That split-apex case stays reachable by
	// hand-editing the generated config (network.*/domain.* are free strings); the
	// wizard trades it away for a UI that can't produce an unreachable host.
	const hostLabels = ref<SubdomainLabels>(defaultSubdomainLabels());
	// mail/bounce are inert without the self-hosted MTA (nothing consumes those
	// hostnames), so they are disabled — not validated or gated — for other
	// providers, and only the live labels are checked for distinctness.
	const HOST_LABEL_INACTIVE_HINT = 'desktop.setup.hostLabels.inactiveHint';
	const disabledLabelKeys = computed<SubdomainKey[]>(() =>
		usesOwnMta.value ? [] : ['mail', 'bounce']
	);
	const activeLabelKeys = computed<SubdomainKey[]>(() =>
		SUBDOMAIN_KEYS.filter((k) => !disabledLabelKeys.value.includes(k))
	);
	/** Per-field label validation (charset/length + mutual distinctness) of the live labels. */
	const labelValidation = computed(() =>
		validateSubdomainLabels(hostLabels.value, activeLabelKeys.value)
	);
	const seedDemo = ref(false);
	const configError = ref('');

	/** Whether a domain has been entered (every hostname derives from it). */
	const hasDomain = computed(() => !!domain.value.trim());

	/** Hostnames for the entered domain with the current label overrides applied. */
	const effectiveHosts = computed<InstanceHostnames | null>(() =>
		hasDomain.value ? deriveHostnames(domain.value, hostLabels.value) : null
	);

	function buildConfig(sending: SendingConfig): SetupConfigInput {
		const cfg: SetupConfigInput = {
			version: 1,
			deploymentMode: 'selfhost',
			features: { packs: { ...packs } },
			admin: {
				email: adminEmail.value.trim(),
				name: adminName.value.trim(),
				password: adminPassword.value,
			},
			seedDemo: seedDemo.value,
			sending,
		};

		if (aiProvider.value === 'ollama') cfg.ai = { provider: 'ollama' };
		else if (aiProvider.value === 'openrouter')
			cfg.ai = { provider: 'openrouter', apiKey: aiKey.value.trim() };
		else if (aiProvider.value === 'openai')
			cfg.ai = { provider: 'openai', apiKey: aiKey.value.trim() };

		const hosts = effectiveHosts.value;
		if (hosts) {
			cfg.network = networkUrlsFromHosts(hosts);
			if (usesOwnMta.value) {
				cfg.domain = { ehloHostname: hosts.mail, bounceDomain: hosts.bounce };
			}
		}
		return cfg;
	}

	const stepOptions = computed(() => configSteps.map((s) => ({ value: s.id, label: t(s.label) })));
	// Step navigation is the shared wizard composable, not a second hand-rolled
	// copy of it. The step is deliberately NOT synced to the URL here: the SSH
	// session this wizard configures lives only in memory, so a reload drops back
	// to Connect and a shareable `?step=admin` would be a link to a wizard that is
	// not running.
	const {
		currentStep: configStep,
		currentStepIndex: stepIndex,
		isLastStep,
		goToStep: goStep,
		goToNext: nextStep,
		goToPrevious: prevStep,
	} = useWizard<ConfigStep>(
		configSteps.map((step, index) => ({ id: step.id, label: step.label, number: index + 1 }))
	);

	async function onProvision() {
		configError.value = '';
		const kind = sendingProvider.value;
		if (!isSetupSendingKind(kind)) return;
		const sending = sendingConfigFromCredentials(kind, (envVar) => sendingCredentials[envVar]);
		if (!sending.ok) {
			configStep.value = 'providers';
			configError.value = sendingProblemMessage(sending.problem);
			return;
		}
		// A remote server needs a public domain, otherwise the install bakes a
		// localhost URL the app can never open. Block before provisioning.
		if (isRemoteTarget.value && !hasDomain.value) {
			configStep.value = 'domain';
			configError.value = t('desktop.setup.errors.domainRequired');
			return;
		}
		// Customised hostname labels must be DNS-safe and mutually distinct, or the
		// derived hostnames/DNS records would collide or be invalid.
		if (!labelValidation.value.ok) {
			configStep.value = 'domain';
			configError.value = t('desktop.setup.errors.invalidHostLabels');
			return;
		}
		// Admin fields live on the last step; jump there if they fail validation.
		const fail = (msg: string) => {
			configStep.value = 'admin';
			configError.value = msg;
		};
		if (!/^.+@.+\..+$/.test(adminEmail.value))
			return fail(t('desktop.setup.errors.adminEmailInvalid'));
		if (!adminName.value.trim()) return fail(t('desktop.setup.errors.adminNameRequired'));
		const pw = validateAdminPassword(adminPassword.value, adminPasswordConfirm.value);
		if (!pw.ok) return fail(tk(pw.error) || t('desktop.setup.errors.adminPasswordInvalid'));
		await provision(buildConfig(sending.config));
	}

	return {
		packs,
		packOptions,
		sendingProvider,
		sendingCredentials,
		sendingPreset,
		sendingPresetOptions,
		sendingOptions,
		usesOwnMta,
		outboundTlsHint,
		aiProvider,
		aiKey,
		adminEmail,
		adminName,
		adminPassword,
		adminPasswordConfirm,
		revealPassword,
		passwordAssessment,
		adminPasswordError,
		domain,
		publicIp,
		hostLabels,
		HOST_LABEL_INACTIVE_HINT,
		disabledLabelKeys,
		labelValidation,
		seedDemo,
		configError,
		hasDomain,
		effectiveHosts,
		configSteps,
		stepOptions,
		configStep,
		stepIndex,
		isLastStep,
		goStep,
		nextStep,
		prevStep,
		onProvision,
	};
}

export type SetupConfigForm = ReturnType<typeof useSetupConfigForm>;
