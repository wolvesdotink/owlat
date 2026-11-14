/**
 * Non-interactive setup paths — the two ways the wizard runs with NO prompts:
 *
 *   1. `--config <file>` — a JSON {@link SetupConfig} supplies every answer (CI
 *      and the desktop app driving a remote install over SSH).
 *   2. `--assume-yes` — the documented `OWLAT_ASSUME_YES=1 curl … | bash`
 *      install, where stdin is not a TTY and every clack prompt would block
 *      forever. A complete config is assembled from sensible defaults (plus
 *      environment overrides) instead.
 *
 * Both resolve through `buildSetupFromConfig` — the SAME mapper — and write
 * through `persistResolvedSetup`, which the interactive wizard uses too, so
 * the config file and the headless defaults cannot drift. Split out of `commands/setup.ts` (which keeps the interactive TUI) so
 * each file stays under the file-size cap; `runSetup` delegates here.
 */

import { log } from '@clack/prompts';
import pc from 'picocolors';
import { readFile } from 'node:fs/promises';
import { readEnv, type EnvMap } from '../lib/env';
import { generateSecret } from '@owlat/shared/setupSecrets';
import { OWN_SEND_PROVIDER_KIND, isOwnSendProviderKind } from '@owlat/shared/sendProviderCatalog';
import { systemFromIdentityEnv } from '@owlat/shared/systemFromIdentity';
import {
	SETUP_SENDING_CATALOG_ENTRIES,
	isSetupSendingKind,
	sendingConfigFromCredentials,
} from '@owlat/shared/setupSendingConfig';
import { persistResolvedSetup } from '../lib/persistSetup';
import { createReporter, SetupStep } from '../lib/progress';
import {
	parseSetupConfig,
	buildSetupFromConfig,
	type DeploymentMode,
	type SetupConfig,
	type SendingConfig,
	type AiConfig,
} from '../lib/setupConfig';

interface ConfigFileArgs {
	configFile: string;
	owlatDir: string;
	envPath: string;
	overridePath: string;
}

/**
 * Non-interactive setup from a JSON config file. Produces the same `.env` +
 * compose override + flag-state the terminal wizard would, but with no prompts.
 * Emits structured progress (`OWLAT_PROGRESS=json`) so a remote driver can
 * render it.
 */
export async function applyConfigFile({
	configFile,
	owlatDir,
	envPath,
	overridePath,
}: ConfigFileArgs): Promise<number> {
	const reporter = createReporter();
	reporter.step(SetupStep.Config, 'Applying configuration');

	let raw: string;
	try {
		raw = await readFile(configFile, 'utf-8');
	} catch (e) {
		reporter.fail(`Could not read ${configFile}: ${(e as Error).message}`);
		if (!reporter.isJson)
			log.error(`Could not read config file ${configFile}: ${(e as Error).message}`);
		return 1;
	}

	let resolved;
	try {
		const config = parseSetupConfig(JSON.parse(raw));
		const existingEnv = await readEnv(envPath);
		resolved = buildSetupFromConfig(config, existingEnv);
	} catch (e) {
		reporter.fail((e as Error).message);
		if (!reporter.isJson) log.error(`Invalid setup config: ${(e as Error).message}`);
		return 1;
	}

	const profiles = await persistResolvedSetup({
		owlatDir,
		envPath,
		overridePath,
		env: resolved.env,
		flags: resolved.flags,
		hosted: resolved.hosted,
	});

	reporter.ok(`profiles: ${profiles.join(', ') || 'none'}`);
	if (!reporter.isJson) {
		log.success(
			`Wrote ${pc.cyan(envPath)} and ${pc.cyan(overridePath)} from ${pc.cyan(configFile)} (profiles: ${profiles.join(', ') || 'none'})`
		);
	}
	return 0;
}

interface ApplyArgs {
	owlatDir: string;
	envPath: string;
	overridePath: string;
	existingEnv: EnvMap;
}

/**
 * Apply the headless `--assume-yes` configuration: produces the exact same
 * `.env` + compose override + flag-state the terminal wizard would, but from
 * defaults/environment instead of prompts. Resolves through
 * `buildSetupFromConfig` (shared with the `--config` path) and writes through
 * `persistResolvedSetup` (shared with every setup route), so neither half of
 * the non-interactive routes can diverge.
 */
export async function applyAssumeYes({
	owlatDir,
	envPath,
	overridePath,
	existingEnv,
}: ApplyArgs): Promise<number> {
	let resolved;
	try {
		const config = buildAssumeYesConfig(existingEnv);
		resolved = buildSetupFromConfig(config, existingEnv);
		// The mapper proposes noreply@<EHLO hostname>; an address the operator
		// gave replaces it, the way the terminal wizard's From prompt does.
		const read = assumeYesReader(existingEnv);
		const fromEmail = read('DEFAULT_FROM_EMAIL');
		if (config.domain && fromEmail) {
			Object.assign(
				resolved.env,
				systemFromIdentityEnv(config.domain.ehloHostname, fromEmail, read('DEFAULT_FROM_NAME'))
			);
		}
	} catch (e) {
		log.error(`Headless setup could not assemble a config: ${(e as Error).message}`);
		return 1;
	}

	const profiles = await persistResolvedSetup({
		owlatDir,
		envPath,
		overridePath,
		env: resolved.env,
		flags: resolved.flags,
		hosted: resolved.hosted,
	});

	log.success(
		`Wrote ${pc.cyan(envPath)} and ${pc.cyan(overridePath)} from assume-yes defaults ` +
			`(deployment: ${resolved.deploymentMode}, provider: ${resolved.env['EMAIL_PROVIDER'] ?? 'none'}, ` +
			`profiles: ${profiles.join(', ') || 'none'}).`
	);
	return 0;
}

/**
 * Construct a complete, deployable {@link SetupConfig} for the headless
 * `--assume-yes` install — with NO prompts. Every answer the terminal wizard
 * would ask for is resolved from an explicit environment override or a sensible
 * default:
 *
 *   • deployment mode → `OWLAT_DEPLOYMENT_MODE` or `selfhost`
 *   • features        → the default pack for that mode (`getDefaultFlags`)
 *   • sending         → an env-configured provider when its credentials are
 *                       present, else the bundled self-hosted MTA (the only
 *                       provider that needs no third-party key, so the only one
 *                       selectable unattended)
 *   • AI              → only when fully specified in the env (the default pack
 *                       leaves AI off, so a provider is never required)
 *   • admin           → `OWLAT_ADMIN_{EMAIL,NAME,PASSWORD}` or the dev
 *                       email/name defaults plus a RANDOMLY GENERATED password
 *                       (the historical hardcoded default is public knowledge,
 *                       so it must never be silently provisioned; bootstrap-org
 *                       additionally refuses placeholder passwords outright)
 *   • mail identity   → for the self-hosted MTA, `EHLO_HOSTNAME` and
 *                       `RETURN_PATH_DOMAIN`, with no default (see
 *                       `resolveMailIdentity`); the system From follows the
 *                       EHLO hostname unless `DEFAULT_FROM_EMAIL` is given
 *
 * Pure and prompt-free: it calls no clack function, so it structurally cannot
 * block a non-TTY. Exported for the regression test. `process.env` takes
 * precedence over the existing `.env`, so a re-run honors live overrides.
 */
export function buildAssumeYesConfig(existingEnv: EnvMap): SetupConfig {
	const read = assumeYesReader(existingEnv);

	const modeRaw = read('OWLAT_DEPLOYMENT_MODE');
	const deploymentMode: DeploymentMode =
		modeRaw === 'dev' || modeRaw === 'hosted' || modeRaw === 'selfhost' ? modeRaw : 'selfhost';

	const config: SetupConfig = {
		version: 1,
		deploymentMode,
		// Empty overrides → the default feature pack for this mode.
		features: {},
		sending: resolveSending(read),
		admin: {
			email: read('OWLAT_ADMIN_EMAIL') ?? 'dev@example.com',
			name: read('OWLAT_ADMIN_NAME') ?? 'Dev Admin',
			password: read('OWLAT_ADMIN_PASSWORD') ?? generateSecret(24),
		},
	};

	const ai = resolveAi(read);
	if (ai) config.ai = ai;

	if (isOwnSendProviderKind(config.sending?.provider)) {
		config.domain = resolveMailIdentity(read);
	}

	return config;
}

/**
 * Every variable a headless install reads from its environment. `scripts/owlat`
 * passes exactly these into the installer container, and nothing else from the
 * host (a test holds its list equal to this one), so an answer read here that
 * is missing from the list would be lost on the `curl … | bash` path.
 */
export const ASSUME_YES_ENV_KEYS: readonly string[] = Object.freeze([
	'OWLAT_DEPLOYMENT_MODE',
	'OWLAT_ADMIN_EMAIL',
	'OWLAT_ADMIN_NAME',
	'OWLAT_ADMIN_PASSWORD',
	'EHLO_HOSTNAME',
	'RETURN_PATH_DOMAIN',
	'DEFAULT_FROM_EMAIL',
	'DEFAULT_FROM_NAME',
	'EMAIL_PROVIDER',
	...new Set(
		SETUP_SENDING_CATALOG_ENTRIES.flatMap((entry) =>
			entry.credentialFields.flatMap((field) =>
				field.kind === 'host-port'
					? [field.envVar, field.portEnvVar, field.secureEnvVar]
					: [field.envVar]
			)
		)
	),
	'LLM_PROVIDER',
	'LLM_API_KEY',
	'LLM_BASE_URL',
	'LLM_MODEL_FAST',
	'LLM_MODEL_CAPABLE',
]);

/** An answer from `process.env`, else from the existing `.env`; empty counts as unset. */
function assumeYesReader(existingEnv: EnvMap): (key: string) => string | undefined {
	return (key) => {
		if (!ASSUME_YES_ENV_KEYS.includes(key)) {
			throw new Error(
				`${key} is read by the headless install but missing from ASSUME_YES_ENV_KEYS`
			);
		}
		return process.env[key] || existingEnv[key] || undefined;
	};
}

/**
 * The admin account a headless quickstart creates, from `OWLAT_ADMIN_*`; each
 * missing answer falls back to quickstart's own default.
 */
export function assumeYesAdminFromEnv(): { email?: string; name?: string; password?: string } {
	const read = assumeYesReader({});
	const email = read('OWLAT_ADMIN_EMAIL');
	const name = read('OWLAT_ADMIN_NAME');
	const password = read('OWLAT_ADMIN_PASSWORD');
	return {
		...(email ? { email } : {}),
		...(name ? { name } : {}),
		...(password ? { password } : {}),
	};
}

/**
 * The built-in mail server's sending identity. Nothing can stand in for it: the
 * EHLO hostname must be the name this server's reverse DNS gives, and the
 * system From follows it, so a made-up default would either fail the identity
 * gate after the stack is up or send mail under a domain the operator does not
 * own. Refuse up front and name the answers instead.
 */
function resolveMailIdentity(
	read: (key: string) => string | undefined
): NonNullable<SetupConfig['domain']> {
	const ehloHostname = read('EHLO_HOSTNAME');
	const bounceDomain = read('RETURN_PATH_DOMAIN');
	if (ehloHostname && bounceDomain) return { ehloHostname, bounceDomain };
	const missing = [
		...(ehloHostname ? [] : ['EHLO_HOSTNAME']),
		...(bounceDomain ? [] : ['RETURN_PATH_DOMAIN']),
	].join(' and ');
	throw new Error(
		`the built-in mail server needs ${missing}: the hostname this server's reverse DNS (PTR) names, and the bounce domain. ` +
			'Set them in the environment, or install from a config file (--config, OWLAT_CONFIG_FILE) with a `domain` section. ' +
			'System mail is then sent as noreply@<EHLO_HOSTNAME> unless DEFAULT_FROM_EMAIL is set.'
	);
}

/**
 * Pick the sending provider for an unattended install. Honors an explicitly
 * configured `EMAIL_PROVIDER` only when every credential its catalog entry
 * requires is already present (and well-formed) in the environment; otherwise
 * falls back to the self-hosted MTA, which needs no third-party key and is
 * therefore the only provider selectable without a prompt.
 *
 * The variables are read through the send-provider catalog's credential fields
 * (`sendingConfigFromCredentials`, shared with the desktop wizard), so every
 * provider the setup config can carry is honored here without naming it.
 */
function resolveSending(read: (key: string) => string | undefined): SendingConfig {
	const provider = read('EMAIL_PROVIDER');
	if (isSetupSendingKind(provider)) {
		const result = sendingConfigFromCredentials(provider, read);
		if (result.ok) return result.config;
	}
	return { provider: OWN_SEND_PROVIDER_KIND };
}

/**
 * Wire an AI provider for an unattended install only when one is fully specified
 * in the environment. The default feature pack leaves AI off, so a provider is
 * never required; returning `undefined` keeps the config minimal.
 */
function resolveAi(read: (key: string) => string | undefined): AiConfig | undefined {
	const provider = read('LLM_PROVIDER');
	if (provider === 'ollama') return { provider: 'ollama' };
	if (provider === 'openrouter' || provider === 'openai') {
		const apiKey = read('LLM_API_KEY');
		if (apiKey) return { provider, apiKey };
	}
	if (provider === 'custom') {
		const baseUrl = read('LLM_BASE_URL');
		const apiKey = read('LLM_API_KEY');
		const modelFast = read('LLM_MODEL_FAST');
		const modelCapable = read('LLM_MODEL_CAPABLE');
		if (baseUrl && apiKey && modelFast && modelCapable) {
			return { provider: 'custom', baseUrl, apiKey, modelFast, modelCapable };
		}
	}
	return undefined;
}
