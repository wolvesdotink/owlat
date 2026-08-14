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
import {
	PROVIDER_ENV_KEYS,
	SMTP_RELAY_PRESETS,
	type SmtpRelayPreset,
} from '@owlat/shared/setupSendingPresets';
import { isOwnSendProviderKind, type SendTransportKind } from '@owlat/shared/sendProviderCatalog';
import type { OutboundTlsMode } from '@owlat/shared/outboundTlsMode';
import { buildMtaIdentityEnv, type MtaIdentityDraft } from '~/utils/setupMtaIdentity';
import {
	credentialValuesFromDraft,
	transportCredentialEnv,
	type TransportCredentialValues,
} from './setupWizardCredentials';
import { SETUP_DRAFT_STORAGE_KEY, readSetupDraft, serializeSetupDraft } from './setupWizardDraft';
import {
	COMPOSED_TRANSPORT_CREDENTIAL_ENV_KEYS,
	composedSendProviderCatalogEntry,
	isComposedSendProviderKind,
} from '~/utils/composedSendProviderCatalog';

// Re-export the shared preset table and its key type so the setup step (and its
// tests) keep importing them from this composable; the single source of truth
// lives in `@owlat/shared/setupSendingPresets`, shared with the setup CLI.
export { SMTP_RELAY_PRESETS, PROVIDER_ENV_KEYS };
export type SmtpPreset = SmtpRelayPreset;

// The outbound-TLS selector surface (option list, `seedOutboundTlsMode`, and the
// `OutboundTlsMode` re-export) lives in the sibling `setupOutboundTls` module,
// split out to keep this file under the file-size ratchet. This file still uses
// the `OutboundTlsMode` type for the email step draft below.

// ── Steps ────────────────────────────────────────────────────────────────────

/**
 * The wizard's steps. `label` is an i18n MESSAGE KEY, not a word: this list is
 * built at module scope, before any component sets up, so the step indicator
 * resolves it with `t(step.label)` where it renders.
 */
export const SETUP_STEPS = [
	{ id: 'mode', label: 'shared.useSetupWizard.steps.mode', number: 1 },
	{ id: 'features', label: 'shared.useSetupWizard.steps.features', number: 2 },
	{ id: 'email', label: 'shared.useSetupWizard.steps.email', number: 3 },
	{ id: 'admin', label: 'shared.useSetupWizard.steps.admin', number: 4 },
	{ id: 'review', label: 'shared.useSetupWizard.steps.review', number: 5 },
] as const;

export type SetupStepId = (typeof SETUP_STEPS)[number]['id'];

/** Mutable copy of {@link SETUP_STEPS} for `useWizard`, which expects `WizardStep[]`. */
export const SETUP_WIZARD_STEPS = SETUP_STEPS.map((s) => ({ ...s }));

/**
 * Route path for a step. Each `/setup/*` page is named after its step id, so
 * this is the single mapping the step indicator uses to jump back to a
 * completed step. Kept here (not inlined in the pages) so the id⇄route contract
 * lives next to the step list it derives from.
 */
export function setupStepPath(stepId: SetupStepId): string {
	return `/setup/${stepId}`;
}

// ── Shared draft types ───────────────────────────────────────────────────────

/**
 * What the wizard's provider picker can be set to: any kind the catalog
 * declares, or the receive-only answer.
 *
 * DERIVED, per the seams plan's D1 — this used to be the fifth independent
 * spelling of the kind union (the catalog, `SEND_TRANSPORT_KINDS`,
 * `DELIVERY_PROVIDER_KINDS`, `RelayProviderChoice` and this one), so a provider
 * had to be remembered here as well as declared. `'none'` is this surface's own
 * word and belongs to no provider: it means "no delivery transport at all",
 * which is a legal answer for a receive-only install and never a catalog entry.
 */
export type ProviderChoice = SendTransportKind | 'none';

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
	/** Emailit API key. Optional for compatibility with persisted pre-Emailit drafts. */
	emailitKey?: string;
	/**
	 * Mailchimp Transactional (Mandrill) API key. One field, because that is the
	 * whole sending credential — the webhook signing key, the subaccount and the
	 * IP pool are set in `.env` out of band (see `PROVIDER_ENV_KEYS`).
	 */
	mandrillKey: string;
	ses: SesCredentials;
	smtp: SmtpRelayDraft;
	/**
	 * Outbound TLS posture for the built-in MTA. Optional — omitted drafts (and
	 * every non-`mta` transport) fall back to the `opportunistic` default, which
	 * is byte-identical to the historic behaviour.
	 */
	outboundTlsMode?: OutboundTlsMode;
	/** MTA can be enabled by receiving profiles even when delivery uses a relay. */
	mtaProfileEnabled?: boolean;
	mtaIdentity?: MtaIdentityDraft;
	/** Optional From-identity — flows into the apply contract's `env`. */
	fromEmail: string;
	fromName: string;
}

// ── Pure validation ──────────────────────────────────────────────────────────

// The step rules (`validateAdmin`, `validateEmailStep`, `transportStepIsValid`
// and friends) live in the sibling `setupWizardValidation` module, split out —
// like the outbound-TLS surface above — to keep this file under the file-size
// ratchet. They are pure functions over the draft types declared here.

/**
 * Build the env patch for the email step from the current draft, starting from
 * the existing env. Pure so it can be unit-tested and reused by the page's
 * `next()` handler. Resend keys are validated over the network in the page
 * before this is committed; this only assembles values.
 *
 * THE PER-PROVIDER IF-CHAIN IS GONE (the seams plan's D1/D5). This function used
 * to restate, as imperative code, the same mapping the catalog declares: one
 * `if (draft.provider === …)` per vendor, each naming that vendor's env
 * variables and its normalisation rules. It now writes whatever the selected
 * entry's `credentialFields` declare, through `transportCredentialEnv` — so a
 * sixth provider reaches this patch by existing in the catalog, and the rules
 * that used to be per-vendor (trim the relay host, default a blank port to 587,
 * always emit the own MTA's TLS floor) are per FIELD KIND, stated once beside
 * the descriptors they belong to.
 */
export function buildProviderEnv(
	existing: Record<string, string>,
	draft: EmailStepDraft,
	credentialValues: TransportCredentialValues = credentialValuesFromDraft(draft)
): Record<string, string> {
	const next: Record<string, string> = { ...existing };
	for (const key of [...PROVIDER_ENV_KEYS, ...COMPOSED_TRANSPORT_CREDENTIAL_ENV_KEYS]) {
		delete next[key];
	}

	if (isComposedSendProviderKind(draft.provider)) {
		next['EMAIL_PROVIDER'] = draft.provider;
		Object.assign(next, transportCredentialEnv(draft.provider, credentialValues));
	}
	// The sending IPs and the EHLO identity are the OWN ARM's — D3's one
	// legitimate identity question, asked through the catalog's `tier: 'own'`
	// declaration rather than by comparing the choice to a literal. They are also
	// collected when the MTA runs only as a receiving profile beside a relay.
	if (isOwnSendProviderKind(draft.provider) || draft.mtaProfileEnabled) {
		const identity = draft.mtaIdentity;
		if (identity) {
			Object.assign(next, buildMtaIdentityEnv(identity));
			if (!identity.ehloHostnames.trim()) delete next['EHLO_HOSTNAMES'];
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
	/** i18n message key (or the catalog's own label) — resolve with `t()`. */
	providerLabel: string;
	fromIdentity: string | null;
	adminEmail: string;
	adminName: string;
	/** Bulk sending is on but no real provider is set — launch must be blocked. */
	missingProvider: boolean;
}

/**
 * The operator's name for each choice on the REVIEW step — the catalog's label
 * for every kind it declares, plus this surface's own words for the two answers
 * no catalog entry carries.
 *
 * Both survivors are i18n MESSAGE KEYS — this runs at module scope, so the
 * review step resolves whatever it gets with `t()` (a catalog label, which no
 * message defines, resolves to itself).
 *
 * DERIVED (D1): the hand-written table this replaced restated `entry.label` for
 * all four relays, so a provider had to be remembered here as well as declared.
 * TWO STRINGS SURVIVE IT, and neither is a vendor's:
 *
 *  - `none` is this surface's own answer ("no transport at all"), legal for a
 *    receive-only install and never a catalog entry;
 *  - the OWN ARM's qualifier. This step summarises a CHOICE rather than naming a
 *    product — "(self-hosted)" is what distinguishes it from the managed options
 *    listed beside it — and it is the string the shipped review step has always
 *    shown. Keyed by `OWN_SEND_PROVIDER_KIND`, D3's one definitional identity,
 *    so it is not a vendor table and cannot grow one: any other kind, present or
 *    future, reads its label from the entry.
 *
 * The delivery hub, the transport editor's picker and this step each still word
 * the own MTA slightly differently, exactly as they shipped; unifying that copy
 * is a deliberate wording decision for the plan owner, not something a rendering
 * refactor gets to do silently (recorded in `scripts/provider-identity-allowlist.txt`).
 */
const RECEIVE_ONLY_LABEL = 'shared.useSetupWizard.provider.receiveOnly';

const OWN_ARM_REVIEW_LABEL = 'shared.useSetupWizard.provider.ownArm';

function providerLabel(provider: ProviderChoice): string {
	if (isOwnSendProviderKind(provider)) return OWN_ARM_REVIEW_LABEL;
	return composedSendProviderCatalogEntry(provider)?.label ?? RECEIVE_ONLY_LABEL;
}

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

	// Any kind the catalog declares is a real choice; anything else — unset, or a
	// transport this build does not carry — reads as no provider at all, which is
	// the fail-closed answer the launch gate below depends on.
	const rawProvider = env['EMAIL_PROVIDER'];
	const provider: ProviderChoice = isComposedSendProviderKind(rawProvider) ? rawProvider : 'none';

	const fromEmail = env['DEFAULT_FROM_EMAIL'];
	const fromName = env['DEFAULT_FROM_NAME'];
	const fromIdentity = fromEmail ? (fromName ? `${fromName} <${fromEmail}>` : fromEmail) : null;

	return {
		activeFeatures,
		provider,
		providerLabel: providerLabel(provider),
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
	// One-time setup token from `owlat setup`; sent in the X-Setup-Token header on
	// the privileged endpoints. Shared across steps and persisted like the rest.
	const setupToken = useState<string>('setupToken', () => '');
	// Set once launch succeeds — disarms the unload warning and stops persisting.
	const completed = useState<boolean>('setupCompleted', () => false);

	// Client-only: restore any saved draft, then mirror every change back into
	// sessionStorage so a refresh or accidental back-navigation out of /setup/*
	// no longer wipes the collected config, and warn before an actual tab close
	// while the draft still holds data. `useState` bakes SSR state into the
	// payload and does NOT re-run its initializer on the client, so the restore
	// has to happen explicitly here rather than in the initializers above.
	if (import.meta.client) {
		const hydrated = useState<boolean>('setupHydrated', () => false);
		if (!hydrated.value) {
			const stored = readSetupDraft();
			if (stored) {
				if (stored.flags) flags.value = { ...getDefaultFlags(), ...stored.flags };
				if (stored.env) env.value = { ...stored.env };
				if (stored.admin) admin.value = { ...admin.value, ...stored.admin };
				if (typeof stored.isMigrationMode === 'boolean') {
					isMigrationMode.value = stored.isMigrationMode;
				}
				if (typeof stored.token === 'string') setupToken.value = stored.token;
			}
			hydrated.value = true;
		}

		watch(
			[flags, env, admin, isMigrationMode, setupToken],
			() => {
				if (completed.value) return;
				try {
					sessionStorage.setItem(
						SETUP_DRAFT_STORAGE_KEY,
						serializeSetupDraft({
							flags: flags.value,
							env: env.value,
							admin: admin.value,
							isMigrationMode: isMigrationMode.value,
							token: setupToken.value,
						})
					);
				} catch {
					// Storage full/unavailable — persistence is best-effort, never fatal.
				}
			},
			{ deep: true }
		);

		const hasDraftData = (): boolean =>
			admin.value.email !== '' ||
			admin.value.name !== '' ||
			admin.value.password !== '' ||
			setupToken.value !== '' ||
			Object.keys(env.value).length > 0;

		const onBeforeUnload = (e: BeforeUnloadEvent) => {
			if (!completed.value && hasDraftData()) {
				e.preventDefault();
				e.returnValue = '';
			}
		};
		onMounted(() => window.addEventListener('beforeunload', onBeforeUnload));
		onUnmounted(() => window.removeEventListener('beforeunload', onBeforeUnload));
	}

	const resolved = computed(() => resolveFlags(flags.value));
	const requiresProvider = computed(() => needsDeliveryProvider(flags.value));
	const summary = computed(() => buildSetupSummary(flags.value, env.value, admin.value));

	// Jump back to an already-completed step from the indicator. The single home
	// for the id⇄route navigation the `/setup/*` pages share; the wizard draft is
	// persisted, so returning to an earlier step never loses later input. Accepts
	// a `string` (StepIndicator's `onStepClick` contract) and narrows once here.
	const router = useRouter();
	function goToStep(stepId: string): void {
		router.push(setupStepPath(stepId as SetupStepId));
	}

	/**
	 * Mark the wizard finished: drop the persisted draft and disarm the unload
	 * warning so the post-apply redirect isn't blocked. Call once apply succeeds.
	 */
	function completeSetup(): void {
		completed.value = true;
		if (typeof sessionStorage !== 'undefined') {
			try {
				sessionStorage.removeItem(SETUP_DRAFT_STORAGE_KEY);
			} catch {
				// Best-effort — a failed clear only leaves a stale draft, not a crash.
			}
		}
	}

	return {
		flags,
		env,
		admin,
		isMigrationMode,
		setupToken,
		resolved,
		requiresProvider,
		summary,
		goToStep,
		completeSetup,
	};
}
