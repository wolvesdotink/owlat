/**
 * Non-interactive setup config.
 *
 * The terminal wizard (`commands/setup.ts`) collects answers through clack
 * prompts. That is fine for a human at a TTY, but a program driving the install
 * headlessly — CI, an Ansible run, or the desktop app provisioning a server over
 * SSH — needs to supply the same answers up front. `--config <file>` was always
 * accepted by the CLI entry point but never actually read; this module is the
 * missing piece: a typed JSON schema plus a PURE mapper from that schema to the
 * exact `.env` + flag state the interactive wizard would have produced.
 *
 * Keeping the mapping here (and importing it from `setup.ts`) guarantees the two
 * paths cannot drift: the interactive prompts and the config file feed the same
 * `applySetupDefaults` / env-key shape.
 */

import {
	getDefaultFlags,
	resolveFlags,
	needsDeliveryProvider,
	applyPackToggle,
	FEATURE_FLAGS,
	ALL_FEATURE_FLAG_KEYS,
	type CoreFeatureFlagKey,
	ALL_FEATURE_PACK_KEYS,
	type FeatureFlagKey,
	type FeatureFlagState,
	type FeaturePackKey,
} from '@owlat/shared/featureFlags';
import { ensureSecrets } from './secrets';
import { mergeEnv, type EnvMap } from './env';
import { isValidEmail } from './validators';

export type DeploymentMode = 'selfhost' | 'dev' | 'hosted';

export type SendingConfig =
	| { provider: 'mta' }
	| { provider: 'resend'; apiKey: string }
	| { provider: 'ses'; region: string; accessKeyId: string; secretAccessKey: string }
	| {
			provider: 'smtp';
			host: string;
			/** Optional — defaults to 587 (STARTTLS) in the backend adapter. */
			port?: number;
			/** true ⇒ implicit TLS (usually 465); default false ⇒ STARTTLS (587). */
			secure?: boolean;
			username: string;
			password: string;
	  };

export type AiConfig =
	| { provider: 'openrouter'; apiKey: string }
	| { provider: 'openai'; apiKey: string }
	| { provider: 'ollama' }
	| {
			provider: 'custom';
			baseUrl: string;
			apiKey: string;
			modelFast: string;
			modelCapable: string;
	  };

export interface SetupConfig {
	version: 1;
	deploymentMode: DeploymentMode;
	features: {
		/** Explicit flag overrides (highest precedence). */
		flags?: FeatureFlagState;
		/** Feature-pack toggles, applied on top of the defaults before `flags`. */
		packs?: Partial<Record<FeaturePackKey, boolean>>;
	};
	sending?: SendingConfig;
	ai?: AiConfig;
	integrations?: {
		googleSafeBrowsingKey?: string;
		posthog?: { host: string; apiKey: string };
	};
	admin: { email: string; name: string; password: string };
	/** MTA self-host only — EHLO + Return-Path domains. */
	domain?: { ehloHostname: string; bounceDomain: string };
	/**
	 * Public URLs for remote access (served behind the `tls` Caddy profile).
	 * Omit for a same-host / localhost install. When set, these override the
	 * localhost defaults so the web app + Convex are reachable off-box.
	 */
	network?: { siteUrl: string; convexUrl: string; convexSiteUrl: string };
	/** Seed realistic demo data after bootstrap (default: false). */
	seedDemo?: boolean;
}

/** Thrown when a config file is structurally invalid. Message names the field. */
export class SetupConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SetupConfigError';
	}
}

const DEPLOYMENT_MODES: DeploymentMode[] = ['selfhost', 'dev', 'hosted'];

function asObject(value: unknown, field: string): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new SetupConfigError(`${field} must be an object`);
	}
	return value as Record<string, unknown>;
}

function asString(value: unknown, field: string): string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new SetupConfigError(`${field} must be a non-empty string`);
	}
	return value;
}

/**
 * Validate and narrow an untrusted JSON value into a {@link SetupConfig}.
 * Throws {@link SetupConfigError} with a field-specific message on any problem.
 */
export function parseSetupConfig(raw: unknown): SetupConfig {
	const root = asObject(raw, 'config');

	if (root['version'] !== 1) {
		throw new SetupConfigError('config.version must be 1');
	}

	const deploymentMode = root['deploymentMode'];
	if (
		typeof deploymentMode !== 'string' ||
		!DEPLOYMENT_MODES.includes(deploymentMode as DeploymentMode)
	) {
		throw new SetupConfigError(
			`config.deploymentMode must be one of ${DEPLOYMENT_MODES.join(', ')}`
		);
	}

	const features =
		root['features'] === undefined ? {} : asObject(root['features'], 'config.features');
	if (features['flags'] !== undefined) {
		const flags = asObject(features['flags'], 'config.features.flags');
		for (const [key, value] of Object.entries(flags)) {
			if (!ALL_FEATURE_FLAG_KEYS.includes(key as CoreFeatureFlagKey)) {
				throw new SetupConfigError(`config.features.flags has unknown flag "${key}"`);
			}
			if (typeof value !== 'boolean') {
				throw new SetupConfigError(`config.features.flags.${key} must be a boolean`);
			}
		}
	}
	if (features['packs'] !== undefined) {
		const packs = asObject(features['packs'], 'config.features.packs');
		for (const [key, value] of Object.entries(packs)) {
			if (!ALL_FEATURE_PACK_KEYS.includes(key as FeaturePackKey)) {
				throw new SetupConfigError(`config.features.packs has unknown pack "${key}"`);
			}
			if (typeof value !== 'boolean') {
				throw new SetupConfigError(`config.features.packs.${key} must be a boolean`);
			}
		}
	}

	if (root['sending'] !== undefined) parseSending(root['sending']);
	if (root['ai'] !== undefined) parseAi(root['ai']);

	if (root['integrations'] !== undefined) {
		const integrations = asObject(root['integrations'], 'config.integrations');
		if (integrations['googleSafeBrowsingKey'] !== undefined) {
			asString(integrations['googleSafeBrowsingKey'], 'config.integrations.googleSafeBrowsingKey');
		}
		if (integrations['posthog'] !== undefined) {
			const ph = asObject(integrations['posthog'], 'config.integrations.posthog');
			asString(ph['host'], 'config.integrations.posthog.host');
			asString(ph['apiKey'], 'config.integrations.posthog.apiKey');
		}
	}

	const admin = asObject(root['admin'], 'config.admin');
	const email = asString(admin['email'], 'config.admin.email');
	if (!isValidEmail(email)) {
		throw new SetupConfigError('config.admin.email must be a valid email address');
	}
	asString(admin['name'], 'config.admin.name');
	const password = asString(admin['password'], 'config.admin.password');
	if (password.length < 12) {
		throw new SetupConfigError('config.admin.password must be at least 12 characters');
	}

	if (root['domain'] !== undefined) {
		const domain = asObject(root['domain'], 'config.domain');
		asString(domain['ehloHostname'], 'config.domain.ehloHostname');
		asString(domain['bounceDomain'], 'config.domain.bounceDomain');
	}

	if (root['network'] !== undefined) {
		const network = asObject(root['network'], 'config.network');
		asString(network['siteUrl'], 'config.network.siteUrl');
		asString(network['convexUrl'], 'config.network.convexUrl');
		asString(network['convexSiteUrl'], 'config.network.convexSiteUrl');
	}

	if (root['seedDemo'] !== undefined && typeof root['seedDemo'] !== 'boolean') {
		throw new SetupConfigError('config.seedDemo must be a boolean');
	}

	// Shape verified above. Normalize `features` so callers can always read
	// `config.features.flags/packs` without an undefined check.
	const config: SetupConfig = {
		...(raw as SetupConfig),
		features: features as SetupConfig['features'],
	};

	// Cross-field invariant: bulk sending (campaigns / transactional / automations)
	// dispatches through a delivery provider, so `sending` must be present when any
	// such flag resolves on. An external IMAP mailbox is not a delivery provider.
	// Closes the silent "campaigns:true but no provider" CI/SSH path.
	if (config.sending === undefined && needsDeliveryProvider(resolveSetupFlags(config))) {
		throw new SetupConfigError(
			'config.sending is required when campaigns, transactional, or automations are enabled. Set sending.provider to mta, resend, ses, or smtp, or disable bulk sending.'
		);
	}

	return config;
}

function parseSending(value: unknown): void {
	const sending = asObject(value, 'config.sending');
	switch (sending['provider']) {
		case 'mta':
			return;
		case 'resend':
			asString(sending['apiKey'], 'config.sending.apiKey');
			return;
		case 'ses':
			asString(sending['region'], 'config.sending.region');
			asString(sending['accessKeyId'], 'config.sending.accessKeyId');
			asString(sending['secretAccessKey'], 'config.sending.secretAccessKey');
			return;
		case 'smtp':
			asString(sending['host'], 'config.sending.host');
			asString(sending['username'], 'config.sending.username');
			asString(sending['password'], 'config.sending.password');
			if (sending['port'] !== undefined && typeof sending['port'] !== 'number') {
				throw new SetupConfigError('config.sending.port must be a number');
			}
			if (sending['secure'] !== undefined && typeof sending['secure'] !== 'boolean') {
				throw new SetupConfigError('config.sending.secure must be a boolean');
			}
			return;
		default:
			throw new SetupConfigError('config.sending.provider must be one of mta, resend, ses, smtp');
	}
}

function parseAi(value: unknown): void {
	const ai = asObject(value, 'config.ai');
	switch (ai['provider']) {
		case 'ollama':
			return;
		case 'openrouter':
		case 'openai':
			asString(ai['apiKey'], `config.ai.apiKey`);
			return;
		case 'custom':
			asString(ai['baseUrl'], 'config.ai.baseUrl');
			asString(ai['apiKey'], 'config.ai.apiKey');
			asString(ai['modelFast'], 'config.ai.modelFast');
			asString(ai['modelCapable'], 'config.ai.modelCapable');
			return;
		default:
			throw new SetupConfigError(
				'config.ai.provider must be one of openrouter, openai, ollama, custom'
			);
	}
}

/**
 * Resolve the final feature-flag state from a config: defaults for the mode,
 * then any pack toggles, then explicit flag overrides, then the dependency
 * cascade — exactly the order the interactive wizard applies.
 */
export function resolveSetupFlags(config: SetupConfig): Record<FeatureFlagKey, boolean> {
	const hosted = config.deploymentMode === 'hosted';
	let state: FeatureFlagState = getDefaultFlags({ hosted });

	for (const [pack, on] of Object.entries(config.features.packs ?? {})) {
		state = applyPackToggle(state, pack as FeaturePackKey, on, FEATURE_FLAGS).next;
	}
	if (config.features.flags) {
		state = { ...state, ...config.features.flags };
	}
	return resolveFlags(state, { hosted });
}

/**
 * Build the provider / integration / domain env patch from a config. Mirrors the
 * env keys produced by each step of the terminal wizard. Pure — no secrets, no
 * defaults, no network validation.
 */
export function buildEnvPatchFromConfig(config: SetupConfig): EnvMap {
	const patch: EnvMap = {};

	if (config.sending) {
		switch (config.sending.provider) {
			case 'mta':
				patch['EMAIL_PROVIDER'] = 'mta';
				break;
			case 'resend':
				patch['EMAIL_PROVIDER'] = 'resend';
				patch['RESEND_API_KEY'] = config.sending.apiKey;
				break;
			case 'ses':
				patch['EMAIL_PROVIDER'] = 'ses';
				patch['AWS_SES_REGION'] = config.sending.region;
				patch['AWS_SES_ACCESS_KEY_ID'] = config.sending.accessKeyId;
				patch['AWS_SES_SECRET_ACCESS_KEY'] = config.sending.secretAccessKey;
				break;
			case 'smtp':
				// Generic relay: host + credentials are required; port/TLS have safe
				// backend defaults (587 / STARTTLS), so only emit them when set.
				patch['EMAIL_PROVIDER'] = 'smtp';
				patch['SMTP_RELAY_HOST'] = config.sending.host;
				patch['SMTP_RELAY_USERNAME'] = config.sending.username;
				patch['SMTP_RELAY_PASSWORD'] = config.sending.password;
				if (config.sending.port !== undefined) {
					patch['SMTP_RELAY_PORT'] = String(config.sending.port);
				}
				if (config.sending.secure !== undefined) {
					patch['SMTP_RELAY_SECURE'] = config.sending.secure ? 'true' : 'false';
				}
				break;
		}
	}

	if (config.ai) {
		switch (config.ai.provider) {
			case 'openrouter':
				patch['LLM_PROVIDER'] = 'openrouter';
				patch['LLM_API_KEY'] = config.ai.apiKey;
				patch['OPENROUTER_API_KEY'] = config.ai.apiKey;
				break;
			case 'openai':
				patch['LLM_PROVIDER'] = 'openai';
				patch['LLM_API_KEY'] = config.ai.apiKey;
				patch['OPENAI_API_KEY'] = config.ai.apiKey;
				break;
			case 'ollama':
				patch['LLM_PROVIDER'] = 'ollama';
				break;
			case 'custom':
				patch['LLM_PROVIDER'] = 'custom';
				patch['LLM_BASE_URL'] = config.ai.baseUrl;
				patch['LLM_API_KEY'] = config.ai.apiKey;
				patch['LLM_MODEL_FAST'] = config.ai.modelFast;
				patch['LLM_MODEL_CAPABLE'] = config.ai.modelCapable;
				break;
		}
	}

	if (config.integrations?.googleSafeBrowsingKey) {
		patch['GOOGLE_SAFE_BROWSING_API_KEY'] = config.integrations.googleSafeBrowsingKey;
	}
	if (config.integrations?.posthog) {
		patch['POSTHOG_API_KEY'] = config.integrations.posthog.apiKey;
		patch['POSTHOG_HOST'] = config.integrations.posthog.host;
		patch['NUXT_PUBLIC_POSTHOG_API_KEY'] = config.integrations.posthog.apiKey;
		patch['NUXT_PUBLIC_POSTHOG_HOST'] = config.integrations.posthog.host;
	}

	if (config.domain) {
		patch['EHLO_HOSTNAME'] = config.domain.ehloHostname;
		patch['RETURN_PATH_DOMAIN'] = config.domain.bounceDomain;
		// Wire the system/auth From-identity off the configured sending/EHLO
		// domain. Without these the Convex runtime never receives DEFAULT_FROM_*,
		// so system mail falls back to placeholders (noreply@mail.owlat.app /
		// noreply@example.com — auth/auth.ts, confirmationEmail.ts,
		// transactional/dispatch.ts). The EHLO hostname is the DKIM-signed sending
		// domain the MTA identifies as, so it is the correct From domain. Mirrors
		// the legacy bash wizard (scripts/setup.sh: DEFAULT_FROM_{DOMAIN,EMAIL,NAME}).
		patch['DEFAULT_FROM_DOMAIN'] = config.domain.ehloHostname;
		patch['DEFAULT_FROM_EMAIL'] = `noreply@${config.domain.ehloHostname}`;
		patch['DEFAULT_FROM_NAME'] = 'Owlat';
	}

	if (config.network) {
		// Set in the patch so `applySetupDefaults` (which only fills absent keys)
		// won't clobber them back to localhost. CONVEX_SITE_URL is the function
		// runtime's own site URL; the NUXT_PUBLIC_* values are what the web app
		// and the desktop client (via /api/instance-info) consume.
		patch['SITE_URL'] = config.network.siteUrl;
		patch['NUXT_PUBLIC_SITE_URL'] = config.network.siteUrl;
		patch['NUXT_PUBLIC_CONVEX_URL'] = config.network.convexUrl;
		patch['NUXT_PUBLIC_CONVEX_SITE_URL'] = config.network.convexSiteUrl;
		patch['CONVEX_SITE_URL'] = config.network.convexSiteUrl;
	}

	return patch;
}

/**
 * Fill in default deployment values for keys not already present (preserves an
 * operator's manual edits). Shared by the interactive wizard and the config
 * path so the two cannot diverge. CONVEX_SITE_URL points at the SITE proxy
 * (3211), where the http.route handlers are served; the cloud/sync port is 3210.
 */
export function applySetupDefaults(
	env: EnvMap,
	deploymentMode: DeploymentMode,
	flags?: Partial<Record<FeatureFlagKey, boolean>>
): void {
	const defaults: Record<string, string> = {
		SITE_URL: 'http://localhost:3000',
		CONVEX_SITE_URL: 'http://localhost:3211',
		NUXT_PUBLIC_SITE_URL: 'http://localhost:3000',
		NUXT_PUBLIC_CONVEX_URL: 'http://localhost:3210',
		NUXT_PUBLIC_CONVEX_SITE_URL: 'http://localhost:3211',
		// In-cluster MTA address. Every system/auth email (password reset,
		// invitations, double opt-in, account deletion) is sent through the
		// instance MTA regardless of EMAIL_PROVIDER, and the Convex function
		// runtime reads MTA_API_URL from the pushed deployment env — so it must be
		// set for resend/ses installs too, not only EMAIL_PROVIDER=mta. Without it
		// `selectRuntimeEnvVars` drops the empty key and the backend can send no
		// mail (mtaSendProvider fails with AUTH_FAILED — "MTA_API_URL … is not set").
		// MTA_INTERNAL_URL is the in-cluster address the delivery/scan client
		// (mail/mtaClient.ts) prefers; both point at the same docker service.
		// Matches the legacy bash wizard (scripts/setup.sh: http://mta:3100).
		MTA_API_URL: 'http://mta:3100',
		MTA_INTERNAL_URL: 'http://mta:3100',
		// Dev endpoints (/seed/demo, /dev/reset) are fail-closed unless truthy.
		// Default ON for local 'dev' installs; production self-host stays closed
		// (quickstart flips it on only when demo-seeding).
		OWLAT_DEV_MODE: deploymentMode === 'dev' ? 'true' : 'false',
	};
	// External-mailbox feature (apps/mail-sync worker, mail.external flag): the
	// Convex function runtime dispatches outbound mail for external IMAP/SMTP
	// accounts to the worker at MAIL_SYNC_API_URL. Without it `selectRuntimeEnvVars`
	// drops the empty key, `getOptional('MAIL_SYNC_API_URL')` is undefined, and
	// mail/outbound.ts saves the message to Sent but never dispatches it. The worker
	// listens on MAIL_SYNC_PORT=3200 (docker-compose.yml); the matching
	// MAIL_SYNC_API_KEY is generated in ensureSecrets. Only defaulted when the
	// feature is on so a non-postbox install doesn't push a dangling URL.
	if (flags?.['mail.external']) {
		defaults['MAIL_SYNC_API_URL'] = 'http://mail-sync:3200';
	}
	for (const [key, value] of Object.entries(defaults)) {
		if (env[key] === undefined || env[key] === '') env[key] = value;
	}
}

export interface ResolvedSetup {
	deploymentMode: DeploymentMode;
	hosted: boolean;
	/** Resolved feature-flag state (post-cascade). */
	flags: Record<FeatureFlagKey, boolean>;
	/** Full env to write: existing + patch + secrets + defaults. */
	env: EnvMap;
	admin: { email: string; name: string; password: string };
	seedDemo: boolean;
}

/**
 * The complete, deterministic translation of a config into everything the
 * install needs — the same result the interactive wizard reaches. `env`
 * includes generated secrets (random) and deployment defaults; callers write it
 * to `.env` and persist `flags` to the compose override + flag-state file.
 */
export function buildSetupFromConfig(config: SetupConfig, existingEnv: EnvMap): ResolvedSetup {
	const hosted = config.deploymentMode === 'hosted';
	const flags = resolveSetupFlags(config);

	const patch = buildEnvPatchFromConfig(config);
	patch['OWLAT_DEPLOYMENT_MODE'] = config.deploymentMode;
	patch['OWLAT_HOSTED_MODE'] = hosted ? 'true' : 'false';

	const merged = mergeEnv(existingEnv, patch);
	const withSecrets = ensureSecrets(merged);
	applySetupDefaults(withSecrets, config.deploymentMode, flags);

	return {
		deploymentMode: config.deploymentMode,
		hosted,
		flags,
		env: withSecrets,
		admin: config.admin,
		seedDemo: config.seedDemo ?? false,
	};
}
