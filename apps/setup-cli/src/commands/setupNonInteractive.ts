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
import { OWN_SEND_PROVIDER_KIND } from '@owlat/shared/sendProviderCatalog';
import { isSetupSendingKind, sendingConfigFromCredentials } from '@owlat/shared/setupSendingConfig';
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
 *
 * Pure and prompt-free: it calls no clack function, so it structurally cannot
 * block a non-TTY. Exported for the regression test. `process.env` takes
 * precedence over the existing `.env`, so a re-run honors live overrides.
 */
export function buildAssumeYesConfig(existingEnv: EnvMap): SetupConfig {
	const read = (key: string): string | undefined => {
		const fromProcess = process.env[key];
		if (fromProcess !== undefined && fromProcess !== '') return fromProcess;
		const fromEnv = existingEnv[key];
		return fromEnv !== undefined && fromEnv !== '' ? fromEnv : undefined;
	};

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

	return config;
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
