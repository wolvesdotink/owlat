/**
 * First-run setup wizard — shared state, navigation model, and step validation.
 *
 * The `/setup/*` pages are separate routes that share their collected config
 * through Nuxt `useState`. This composable is the single source of truth for
 * that state plus the *pure* validation/derivation helpers each step gates on,
 * so the step logic (which steps you can leave, what the review screen shows) is
 * unit-testable without mounting Nuxt or a browser.
 *
 * The POST contract to `/api/setup/apply` is unchanged: the wizard still sends
 * `{ flags, env, admin }`. The optional From-identity simply flows into `env`
 * as `DEFAULT_FROM_EMAIL` / `DEFAULT_FROM_NAME`, which `apply.post.ts` already
 * reads (it only fills those keys when absent, so an operator value always wins).
 */

import {
	getDefaultFlags,
	needsDeliveryProvider,
	resolveFlags,
	type FeatureFlagState,
	type FeatureFlagKey,
} from '@owlat/shared/featureFlags';
import { SMTP_RELAY_PRESETS, type SmtpRelayPreset } from '@owlat/shared/setupSendingPresets';

// Re-export the shared preset table and its key type so the setup step (and its
// tests) keep importing them from this composable; the single source of truth
// lives in `@owlat/shared/setupValidators`, shared with the setup CLI.
export { SMTP_RELAY_PRESETS };
export type SmtpPreset = SmtpRelayPreset;

// ── Steps ────────────────────────────────────────────────────────────────────

export const SETUP_STEPS = [
	{ id: 'mode', label: 'Mode', number: 1 },
	{ id: 'features', label: 'Features', number: 2 },
	{ id: 'email', label: 'Email', number: 3 },
	{ id: 'admin', label: 'Account', number: 4 },
	{ id: 'review', label: 'Review', number: 5 },
] as const;

export type SetupStepId = (typeof SETUP_STEPS)[number]['id'];

/** Mutable copy of {@link SETUP_STEPS} for `useWizard`, which expects `WizardStep[]`. */
export const SETUP_WIZARD_STEPS = SETUP_STEPS.map((s) => ({ ...s }));

// ── Shared draft types ───────────────────────────────────────────────────────

export type ProviderChoice = 'mta' | 'resend' | 'ses' | 'smtp' | 'none';

export interface AdminDraft {
	email: string;
	name: string;
	password: string;
}

export interface SesCredentials {
	region: string;
	accessKeyId: string;
	secretAccessKey: string;
}

export interface SmtpRelayDraft {
	preset: SmtpPreset;
	host: string;
	/** Kept as a string because it's a form field; blank ⇒ backend default 587. */
	port: string;
	/** true ⇒ implicit TLS (usually 465); false ⇒ STARTTLS upgrade (587). */
	secure: boolean;
	username: string;
	password: string;
}

export interface EmailStepDraft {
	provider: ProviderChoice;
	/** Whether the chosen features force a real delivery provider (no "none"). */
	requiresProvider: boolean;
	resendKey: string;
	ses: SesCredentials;
	smtp: SmtpRelayDraft;
	/** Optional From-identity — flows into the apply contract's `env`. */
	fromEmail: string;
	fromName: string;
}

// ── Pure validation ──────────────────────────────────────────────────────────

// Mirrors the server's deliberately-lenient check in apply.post.ts so the client
// never blocks an address the backend would accept (or vice-versa). Named
// distinctly from the strict `@owlat/shared` `isValidEmail` (also auto-imported)
// to avoid a Nuxt auto-import collision.
const EMAIL_RE = /^.+@.+\..+$/;

export function isSetupEmailValid(value: string): boolean {
	return EMAIL_RE.test(value.trim());
}

export const MIN_PASSWORD_LENGTH = 12;

export interface AdminErrors {
	email?: string;
	password?: string;
}

export function validateAdmin(admin: AdminDraft): AdminErrors {
	const errors: AdminErrors = {};
	if (!isSetupEmailValid(admin.email)) {
		errors.email = 'Enter a valid email address.';
	}
	if (admin.password.length < MIN_PASSWORD_LENGTH) {
		errors.password = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
	}
	return errors;
}

export function adminIsValid(admin: AdminDraft): boolean {
	return Object.keys(validateAdmin(admin)).length === 0;
}

export interface EmailStepErrors {
	provider?: string;
	resendKey?: string;
	ses?: string;
	smtp?: string;
	fromEmail?: string;
}

/** A relay port is optional (defaults to 587), but if given must be a real port. */
function isValidSmtpPort(port: string): boolean {
	const trimmed = port.trim();
	if (trimmed === '') return true;
	if (!/^\d+$/.test(trimmed)) return false;
	const n = Number.parseInt(trimmed, 10);
	return n >= 1 && n <= 65535;
}

export function validateEmailStep(draft: EmailStepDraft): EmailStepErrors {
	const errors: EmailStepErrors = {};

	if (draft.provider === 'none' && draft.requiresProvider) {
		errors.provider =
			'A delivery provider is required because campaigns, transactional, or automations are enabled. Pick your own MTA, Amazon SES, or an SMTP relay — or disable bulk sending.';
	}
	if (draft.provider === 'resend' && draft.resendKey.trim() === '') {
		errors.resendKey = 'Enter your Resend API key.';
	}
	if (draft.provider === 'ses') {
		const { region, accessKeyId, secretAccessKey } = draft.ses;
		if (!region.trim() || !accessKeyId.trim() || !secretAccessKey.trim()) {
			errors.ses = 'Region, access key ID, and secret access key are all required for SES.';
		}
	}
	if (draft.provider === 'smtp') {
		const { host, port, username, password } = draft.smtp;
		if (!host.trim() || !username.trim() || !password.trim()) {
			errors.smtp = 'Server host, username, and password are all required for an SMTP relay.';
		} else if (!isValidSmtpPort(port)) {
			errors.smtp = 'Port must be a whole number between 1 and 65535 (leave blank for 587).';
		}
	}
	// From-identity is optional, but if supplied it must be a real address.
	if (draft.fromEmail.trim() !== '' && !isSetupEmailValid(draft.fromEmail)) {
		errors.fromEmail = 'Enter a valid From address, or leave it blank.';
	}

	return errors;
}

export function emailStepIsValid(draft: EmailStepDraft): boolean {
	return Object.keys(validateEmailStep(draft)).length === 0;
}

// All env keys this step owns — cleared before re-applying so flipping provider
// or clearing the From-identity never leaves a stale credential behind.
const PROVIDER_ENV_KEYS = [
	'EMAIL_PROVIDER',
	'RESEND_API_KEY',
	'AWS_SES_REGION',
	'AWS_SES_ACCESS_KEY_ID',
	'AWS_SES_SECRET_ACCESS_KEY',
	'SMTP_RELAY_HOST',
	'SMTP_RELAY_PORT',
	'SMTP_RELAY_SECURE',
	'SMTP_RELAY_USERNAME',
	'SMTP_RELAY_PASSWORD',
	'DEFAULT_FROM_EMAIL',
	'DEFAULT_FROM_NAME',
] as const;

/**
 * Build the env patch for the email step from the current draft, starting from
 * the existing env. Pure so it can be unit-tested and reused by the page's
 * `next()` handler. Resend keys are validated over the network in the page
 * before this is committed; this only assembles values.
 */
export function buildProviderEnv(
	existing: Record<string, string>,
	draft: EmailStepDraft
): Record<string, string> {
	const next: Record<string, string> = { ...existing };
	for (const key of PROVIDER_ENV_KEYS) delete next[key];

	if (draft.provider !== 'none') {
		next['EMAIL_PROVIDER'] = draft.provider;
		if (draft.provider === 'resend') {
			next['RESEND_API_KEY'] = draft.resendKey;
		}
		if (draft.provider === 'ses') {
			next['AWS_SES_REGION'] = draft.ses.region;
			next['AWS_SES_ACCESS_KEY_ID'] = draft.ses.accessKeyId;
			next['AWS_SES_SECRET_ACCESS_KEY'] = draft.ses.secretAccessKey;
		}
		if (draft.provider === 'smtp') {
			const { host, port, secure, username, password } = draft.smtp;
			next['SMTP_RELAY_HOST'] = host.trim();
			// Port/TLS have safe backend defaults (587 / STARTTLS), so only emit the
			// port when the operator set one; always record the TLS mode explicitly.
			const trimmedPort = port.trim();
			if (trimmedPort) next['SMTP_RELAY_PORT'] = trimmedPort;
			next['SMTP_RELAY_SECURE'] = secure ? 'true' : 'false';
			next['SMTP_RELAY_USERNAME'] = username;
			next['SMTP_RELAY_PASSWORD'] = password;
		}
	}

	const fromEmail = draft.fromEmail.trim();
	if (fromEmail) next['DEFAULT_FROM_EMAIL'] = fromEmail;
	const fromName = draft.fromName.trim();
	if (fromName) next['DEFAULT_FROM_NAME'] = fromName;

	return next;
}

// ── Review summary ───────────────────────────────────────────────────────────

export interface SetupSummary {
	activeFeatures: FeatureFlagKey[];
	provider: ProviderChoice;
	providerLabel: string;
	fromIdentity: string | null;
	adminEmail: string;
	adminName: string;
	/** Bulk sending is on but no real provider is set — launch must be blocked. */
	missingProvider: boolean;
}

const PROVIDER_LABELS: Record<ProviderChoice, string> = {
	mta: 'Owlat MTA (self-hosted)',
	resend: 'Resend',
	ses: 'Amazon SES',
	smtp: 'SMTP relay',
	none: 'None (receive-only)',
};

/**
 * Derive everything the review step renders from the collected config. Kept pure
 * so a test can assert "the review step renders the collected config" without a
 * DOM: same inputs the page binds to, same derived output.
 */
export function buildSetupSummary(
	flags: FeatureFlagState,
	env: Record<string, string>,
	admin: AdminDraft
): SetupSummary {
	const resolved = resolveFlags(flags);
	const activeFeatures = (Object.keys(resolved) as FeatureFlagKey[]).filter((k) => resolved[k]);

	const rawProvider = env['EMAIL_PROVIDER'];
	const provider: ProviderChoice =
		rawProvider === 'mta' ||
		rawProvider === 'resend' ||
		rawProvider === 'ses' ||
		rawProvider === 'smtp'
			? rawProvider
			: 'none';

	const fromEmail = env['DEFAULT_FROM_EMAIL'];
	const fromName = env['DEFAULT_FROM_NAME'];
	const fromIdentity = fromEmail ? (fromName ? `${fromName} <${fromEmail}>` : fromEmail) : null;

	return {
		activeFeatures,
		provider,
		providerLabel: PROVIDER_LABELS[provider],
		fromIdentity,
		adminEmail: admin.email,
		adminName: admin.name,
		missingProvider: needsDeliveryProvider(resolved) && provider === 'none',
	};
}

// ── Apply body ───────────────────────────────────────────────────────────────

export interface SetupApplyBody {
	flags: FeatureFlagState;
	env: Record<string, string>;
	admin: AdminDraft;
	/** Answer to the wizard's "moving from another platform?" question. */
	isMigrationMode: boolean;
}

/**
 * Assemble the POST body for `/api/setup/apply` from the collected draft. Pure so
 * a test can assert the migration-mode question flows into the apply contract
 * without mounting Nuxt. `isMigrationMode` is the one field the wizard collects
 * that is neither a feature flag nor an env var — it lands on
 * `instanceSettings.isMigrationMode` via the seed path.
 */
export function buildApplyBody(
	flags: FeatureFlagState,
	env: Record<string, string>,
	admin: AdminDraft,
	isMigrationMode: boolean
): SetupApplyBody {
	return { flags, env, admin, isMigrationMode };
}

// ── Post-apply readiness ─────────────────────────────────────────────────────

/**
 * After apply, the running web process still has `OWLAT_SETUP_MODE=true` baked
 * into its env, so the setup-mode middleware would bounce a redirect straight
 * back to `/setup` until the container restarts with the freshly-written `.env`.
 *
 * Rather than race that with a fixed timeout, the review step polls a setup-only
 * endpoint: while setup mode is live it answers 4xx for a bad probe body; once
 * the restart lands it answers 403 ("Setup mode is not active"). A 403 is
 * therefore the all-clear to navigate. Pure so the page's poller stays testable.
 */
export function interpretSetupModeProbe(status: number): boolean {
	return status === 403;
}

// ── Composable: shared reactive state ────────────────────────────────────────

export function useSetupWizard() {
	const flags = useState<FeatureFlagState>('setupFlags', () => getDefaultFlags());
	const env = useState<Record<string, string>>('setupEnv', () => ({}));
	const admin = useState<AdminDraft>('setupAdmin', () => ({ email: '', name: '', password: '' }));
	// "Moving from another platform, or starting fresh?" — default fresh (false).
	const isMigrationMode = useState<boolean>('setupMigrationMode', () => false);

	const resolved = computed(() => resolveFlags(flags.value));
	const requiresProvider = computed(() => needsDeliveryProvider(flags.value));
	const summary = computed(() => buildSetupSummary(flags.value, env.value, admin.value));

	return {
		flags,
		env,
		admin,
		isMigrationMode,
		resolved,
		requiresProvider,
		summary,
	};
}
