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
 * Both apply through `buildSetupFromConfig` — the SAME mapper — so the
 * interactive wizard, the config file, and the headless defaults can never
 * drift. Split out of `commands/setup.ts` (which keeps the interactive TUI) so
 * each file stays under the file-size cap; `runSetup` delegates here.
 */

import { log } from '@clack/prompts';
import pc from 'picocolors';
import { readFile } from 'node:fs/promises';
import { readEnv, writeEnv, type EnvMap } from '../lib/env';
import { sealRelayPasswordForBackup } from '@owlat/shared/envBackupBox';
import { writeComposeOverride } from '../lib/override';
import { saveFlagState } from '../lib/flagState';
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

	// Seal the SMTP relay password in the `.env` BACKUP copy so it is never
	// persisted in plaintext (the deploy reseed unseals it before the live push).
	const envBackup = sealRelayPasswordForBackup(resolved.env);
	await writeEnv(envPath, envBackup);
	const profiles = await writeComposeOverride(overridePath, resolved.flags, {
		hosted: resolved.hosted,
	});
	// Canonicalize COMPOSE_PROFILES in .env (updater + bare docker compose read it).
	await writeEnv(envPath, { ...envBackup, COMPOSE_PROFILES: profiles.join(',') });
	await saveFlagState(owlatDir, resolved.flags);

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
 * defaults/environment instead of prompts. Routes through
 * `buildSetupFromConfig` (shared with the `--config` path) so the
 * non-interactive routes cannot diverge.
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

	// Seal the SMTP relay password in the `.env` BACKUP copy so it is never
	// persisted in plaintext (the deploy reseed unseals it before the live push).
	const envBackup = sealRelayPasswordForBackup(resolved.env);
	await writeEnv(envPath, envBackup);
	const profiles = await writeComposeOverride(overridePath, resolved.flags, {
		hosted: resolved.hosted,
	});
	// Canonicalize COMPOSE_PROFILES in .env (updater + bare docker compose read it).
	await writeEnv(envPath, { ...envBackup, COMPOSE_PROFILES: profiles.join(',') });
	await saveFlagState(owlatDir, resolved.flags);

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
 *   • admin           → `OWLAT_ADMIN_{EMAIL,NAME,PASSWORD}` or the same dev
 *                       defaults `owlat quickstart --assume-yes` uses (the admin
 *                       is display-only in the wizard; the real account is
 *                       created later by `bootstrap-org`)
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
			password: read('OWLAT_ADMIN_PASSWORD') ?? 'devpassword12345',
		},
	};

	const ai = resolveAi(read);
	if (ai) config.ai = ai;

	return config;
}

/**
 * Pick the sending provider for an unattended install. Honors an explicitly
 * configured Resend/SES provider only when its credentials are already present
 * in the environment; otherwise falls back to the self-hosted MTA, which needs
 * no third-party key and is therefore the only provider selectable without a
 * prompt.
 */
function resolveSending(read: (key: string) => string | undefined): SendingConfig {
	const provider = read('EMAIL_PROVIDER');
	if (provider === 'resend') {
		const apiKey = read('RESEND_API_KEY');
		if (apiKey) return { provider: 'resend', apiKey };
	} else if (provider === 'ses') {
		const region = read('AWS_SES_REGION');
		const accessKeyId = read('AWS_SES_ACCESS_KEY_ID');
		const secretAccessKey = read('AWS_SES_SECRET_ACCESS_KEY');
		if (region && accessKeyId && secretAccessKey) {
			return { provider: 'ses', region, accessKeyId, secretAccessKey };
		}
	}
	return { provider: 'mta' };
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
