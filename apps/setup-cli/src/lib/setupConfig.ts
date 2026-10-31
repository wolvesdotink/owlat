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
import { ensureSecrets } from '@owlat/shared/setupSecrets';
import type {
	SendProviderCredentialField,
	SendProviderHostPortField,
} from '@owlat/shared/sendProviderCatalog';
import { SETUP_SENDING_CATALOG_ENTRIES, sendingConfigEnv } from '@owlat/shared/setupSendingConfig';
import { mergeEnv, type EnvMap } from './env';
import { applySetupDefaults } from './setupEnvDefaults';
import { isValidEmail } from './validators';
import { assertFblDedupCutoverConfigured } from './fblDedupSetup';

// The contract's types live in @owlat/shared so the desktop wizard that WRITES
// the config and this parser that READS it share one declaration. This module
// keeps the runtime half (`parseSetupConfig`) and re-exports the types, so its
// importers are unchanged.
import type {
	AiConfig,
	DeploymentMode,
	SendingConfig,
	SetupConfig,
} from '@owlat/shared/setupConfigTypes';
export type { AiConfig, DeploymentMode, SendingConfig, SetupConfig };

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
			`config.sending is required when campaigns, transactional, or automations are enabled. Set sending.provider to ${new Intl.ListFormat('en', { type: 'disjunction' }).format(SENDING_KINDS)}, or disable bulk sending.`
		);
	}

	return config;
}

/**
 * The setup config's sending kinds, in catalog order, for the messages that list
 * them.
 */
const SENDING_KINDS = SETUP_SENDING_CATALOG_ENTRIES.map((entry) => entry.kind);

/**
 * Checks `config.sending` against its kind's catalog credential fields. The
 * property names are the fields' keys (a `host-port` field is `host` / `port` /
 * `secure`), the same mapping {@link sendingConfigEnv} writes through.
 *
 * Required values are checked before optional ones, so a config that is missing
 * a credential is told that first, ahead of a malformed port or TLS flag.
 */
function parseSending(value: unknown): void {
	const sending = asObject(value, 'config.sending');
	const provider = sending['provider'];
	const entry = SETUP_SENDING_CATALOG_ENTRIES.find((e) => e.kind === provider);
	if (entry === undefined) {
		throw new SetupConfigError(
			`config.sending.provider must be one of ${SENDING_KINDS.join(', ')}`
		);
	}
	for (const field of entry.credentialFields) {
		if (!field.required) continue;
		if (field.kind === 'host-port') asString(sending['host'], 'config.sending.host');
		else parseCredentialValue(field, sending[field.key]);
	}
	for (const field of entry.credentialFields) {
		if (field.kind === 'host-port') {
			if (sending['port'] !== undefined && typeof sending['port'] !== 'number') {
				throw new SetupConfigError('config.sending.port must be a number');
			}
			if (sending['secure'] !== undefined && typeof sending['secure'] !== 'boolean') {
				throw new SetupConfigError('config.sending.secure must be a boolean');
			}
		} else if (!field.required && sending[field.key] !== undefined) {
			parseCredentialValue(field, sending[field.key]);
		}
	}
}

/** Checks one credential field's value against what its field kind accepts. */
function parseCredentialValue(
	field: Exclude<SendProviderCredentialField, SendProviderHostPortField>,
	value: unknown
): void {
	const name = `config.sending.${field.key}`;
	if (field.kind === 'select' || (field.kind === 'region-select' && field.options)) {
		const allowed = (field.options ?? []).map((option) => option.value);
		if (typeof value !== 'string' || !allowed.includes(value)) {
			throw new SetupConfigError(`${name} must be one of ${allowed.join(', ')}`);
		}
	} else if (field.kind === 'boolean') {
		if (typeof value !== 'boolean') throw new SetupConfigError(`${name} must be a boolean`);
	} else if (field.kind === 'number') {
		if (typeof value !== 'number') throw new SetupConfigError(`${name} must be a number`);
	} else {
		asString(value, name);
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
		patch['EMAIL_PROVIDER'] = config.sending.provider;
		Object.assign(patch, sendingConfigEnv(config.sending));
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
	const isFreshInstall = Object.keys(existingEnv).length === 0;
	if (!isFreshInstall) assertFblDedupCutoverConfigured(existingEnv);

	const patch = buildEnvPatchFromConfig(config);
	patch['OWLAT_DEPLOYMENT_MODE'] = config.deploymentMode;
	patch['OWLAT_HOSTED_MODE'] = hosted ? 'true' : 'false';

	const merged = mergeEnv(existingEnv, patch);
	const withSecrets = ensureSecrets(merged);
	applySetupDefaults(withSecrets, config.deploymentMode, flags, isFreshInstall);

	return {
		deploymentMode: config.deploymentMode,
		hosted,
		flags,
		env: withSecrets,
		admin: config.admin,
		seedDemo: config.seedDemo ?? false,
	};
}
