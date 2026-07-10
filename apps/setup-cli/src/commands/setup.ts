/**
 * `owlat-setup setup` — first-run wizard.
 *
 * Two paths:
 *   1. Web wizard (default when a browser is available): boots apps/web in setup
 *      mode and opens http://localhost:3000/setup. The CLI exits after launch;
 *      the wizard writes .env + override file via the setup backend endpoints.
 *   2. Terminal wizard: full TUI via @clack/prompts. Same question set.
 *
 * For SSH installs without a local browser, use the terminal wizard
 * (`--terminal`) — the installer one-liner forces it because the browser-based
 * wizard cannot run inside the containerized installer.
 */

import {
	intro,
	outro,
	select,
	multiselect,
	text,
	password,
	confirm,
	isCancel,
	log,
	group,
} from '@clack/prompts';
import { progressSpinner, validateWithSpinner } from '../lib/progress';
import pc from 'picocolors';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
	FEATURE_FLAGS,
	getDefaultFlags,
	getFlagsByCategory,
	resolveFlags,
	type FeatureFlagKey,
	type FeatureFlagState,
} from '@owlat/shared/featureFlags';
import { readEnv, writeEnv, mergeEnv, type EnvMap } from '../lib/env';
import { ensureSecrets } from '../lib/secrets';
import { writeComposeOverride } from '../lib/override';
import { saveFlagState } from '../lib/flagState';
import { applySetupDefaults, type DeploymentMode } from '../lib/setupConfig';
import { applyAssumeYes, applyConfigFile } from './setupNonInteractive';
import { pickSendingProvider } from './setupSendingProvider';
import {
	validateOpenAIKey,
	validateOpenRouterKey,
	validatePostHogHost,
	validateGoogleSafeBrowsingKey,
	isValidEmail,
} from '../lib/validators';

import type { CliOptions } from '../lib/cliOptions';

type RunOptions = Omit<CliOptions, 'args'>;

export async function runSetup(opts: RunOptions): Promise<number> {
	const envPath = join(opts.owlatDir, '.env');
	const overridePath = join(opts.owlatDir, 'docker-compose.override.yml');

	// Non-interactive path: a config file supplies every answer (CI + the desktop
	// app driving a remote install over SSH). `--config` was previously accepted
	// by the CLI entry point but never read; this is where it finally takes effect.
	if (opts.configFile) {
		return await applyConfigFile({
			configFile: opts.configFile,
			owlatDir: opts.owlatDir,
			envPath,
			overridePath,
		});
	}

	const existingEnv = await readEnv(envPath);

	// Headless path: `--assume-yes` (the documented
	// `OWLAT_ASSUME_YES=1 curl … | bash` install) MUST NOT block on an interactive
	// prompt in a non-TTY. Build a complete SetupConfig from sensible defaults
	// (plus environment overrides) and apply it through the same
	// `buildSetupFromConfig` mapper the `--config` path uses, so the two
	// non-interactive routes can never drift. Without this the terminal wizard
	// issued select/multiselect/text prompts below that never resolve when stdin
	// is not a TTY, hanging the install forever.
	if (opts.assumeYes) {
		return await applyAssumeYes({ owlatDir: opts.owlatDir, envPath, overridePath, existingEnv });
	}

	intro(pc.bgCyan(pc.black(' Owlat Setup ')));

	const hasPriorInstall = Object.keys(existingEnv).length > 0;

	if (hasPriorInstall) {
		const proceed = await confirm({
			message: `An existing install was detected at ${opts.owlatDir}. Re-running setup will update .env and the compose override. Continue?`,
			initialValue: false,
		});
		if (isCancel(proceed) || !proceed) {
			outro(pc.yellow('Setup cancelled. Run `owlat-setup config` to make incremental changes.'));
			return 0;
		}
	}

	// Decide path: web or terminal.
	const path = opts.terminal ? 'terminal' : opts.web ? 'web' : await chooseSetupPath();
	if (path === 'cancel') {
		outro(pc.yellow('Setup cancelled.'));
		return 0;
	}

	if (path === 'web') {
		return await launchWebWizard(opts);
	}

	// === Terminal wizard ===

	// Step 1: deployment mode
	const deploymentMode = await select({
		message: 'Deployment mode',
		options: [
			{ label: 'Self-host (single org, one VPS)', value: 'selfhost', hint: 'recommended' },
			{ label: 'Development (local laptop)', value: 'dev' },
			{ label: 'Hosted control plane (multi-tenant)', value: 'hosted', hint: 'advanced' },
		],
	});
	if (isCancel(deploymentMode)) return 1;
	const hosted = deploymentMode === 'hosted';

	// Step 2: feature picker
	const flags = await pickFeatures(hosted);
	if (!flags) return 1;

	// Step 3: sending provider (only if a sending feature is enabled)
	const sendingEnabled = flags.campaigns || flags.transactional || flags.automations;
	let envPatch: EnvMap = {};
	if (sendingEnabled) {
		const sendingResult = await pickSendingProvider();
		if (!sendingResult) return 1;
		envPatch = { ...envPatch, ...sendingResult };
	}

	// Step 4: AI provider (only if AI is enabled)
	if (flags.ai) {
		const aiResult = await pickAIProvider();
		if (!aiResult) return 1;
		envPatch = { ...envPatch, ...aiResult };
	}

	// Step 5: optional integrations
	if (flags['scan.urls']) {
		const sb = await collectGoogleSafeBrowsing();
		if (!sb) return 1;
		envPatch = { ...envPatch, ...sb };
	}
	if (flags['analytics.posthog']) {
		const ph = await collectPostHog();
		if (!ph) return 1;
		envPatch = { ...envPatch, ...ph };
	}

	// Step 6: admin account
	const admin = await collectAdmin();
	if (!admin) return 1;

	// Step 7: domain + DKIM (only for MTA self-host)
	if (envPatch['EMAIL_PROVIDER'] === 'mta' || (sendingEnabled && !envPatch['EMAIL_PROVIDER'])) {
		const dom = await collectDomain();
		if (!dom) return 1;
		envPatch = { ...envPatch, ...dom };
	}

	// === Apply ===
	const s = progressSpinner();
	s.start('Generating secrets and writing config');

	const merged = mergeEnv(existingEnv, envPatch);
	const withSecrets = ensureSecrets(merged);
	withSecrets['OWLAT_DEPLOYMENT_MODE'] = deploymentMode as string;
	withSecrets['OWLAT_HOSTED_MODE'] = hosted ? 'true' : 'false';
	// Deployment URLs + dev-mode default. Shared with the non-interactive config
	// path (lib/setupConfig.applySetupDefaults) so the two can't diverge.
	applySetupDefaults(withSecrets, deploymentMode as DeploymentMode, flags);

	await writeEnv(envPath, withSecrets);
	const profiles = await writeComposeOverride(overridePath, flags, { hosted });
	// Canonicalize COMPOSE_PROFILES in .env (updater + bare docker compose read it; MTA is opt-in now).
	await writeEnv(envPath, { ...withSecrets, COMPOSE_PROFILES: profiles.join(',') });
	// Mirror the resolved flag state to .owlat-flags.json so `doctor`,
	// `feature`, and `pack` operate on the same baseline the wizard chose
	// (without it they recompute from defaults and silently drop selections).
	await saveFlagState(opts.owlatDir, flags);

	s.stop(
		`Wrote ${pc.cyan(envPath)} and ${pc.cyan(overridePath)} (profiles: ${profiles.join(', ') || 'none'})`
	);

	log.info(
		`${pc.bold('Admin user:')} ${admin.email}\n` +
			`${pc.bold('Active features:')} ${Object.entries(flags)
				.filter(([, v]) => v)
				.map(([k]) => k)
				.join(', ')}\n`
	);

	outro(
		pc.green('Config written!') +
			`\n\n${pc.bold('This wrote .env + compose override only — it did not deploy or create your admin.')}\n` +
			`Next: ${pc.cyan(`cd ${opts.owlatDir} && owlat quickstart`)} to bring up the stack,\n` +
			`deploy the Convex functions, push env vars, and create ${admin.email}.\n` +
			`Then open ${pc.cyan('http://localhost:3000')} to sign in.`
	);
	return 0;
}

async function chooseSetupPath(): Promise<'web' | 'terminal' | 'cancel'> {
	const choice = await select({
		message: 'How would you like to configure Owlat?',
		options: [
			{ label: 'Web wizard (opens your browser)', value: 'web', hint: 'recommended' },
			{ label: 'Terminal wizard (here, in this shell)', value: 'terminal' },
		],
	});
	if (isCancel(choice)) return 'cancel';
	return choice as 'web' | 'terminal';
}

async function pickFeatures(hosted: boolean): Promise<FeatureFlagState | null> {
	const defaults = getDefaultFlags({ hosted });
	const byCategory = getFlagsByCategory({ hosted });
	const result: FeatureFlagState = { ...defaults };

	for (const [category, defs] of Object.entries(byCategory)) {
		const options = defs.map((d) => ({
			label: `${d.label} ${pc.dim(`(${d.key})`)}`,
			value: d.key as string,
			hint: d.description,
		}));

		const selected = await multiselect({
			message: `${pc.bold(categoryLabel(category))} — pick what to enable`,
			options,
			initialValues: defs.filter((d) => defaults[d.key]).map((d) => d.key as string),
			required: false,
		});
		if (isCancel(selected)) return null;

		for (const def of defs) {
			result[def.key] = (selected as string[]).includes(def.key);
		}
	}

	// Surface implicit cascade so the user can confirm.
	const resolved = resolveFlags(result, { hosted });
	const droppedByCascade = Object.entries(result).filter(
		([key, v]) => v && !resolved[key as FeatureFlagKey]
	);
	if (droppedByCascade.length > 0) {
		log.warn(
			`The following flags were turned off because a dependency was disabled:\n` +
				droppedByCascade
					.map(([key]) => {
						const def = FEATURE_FLAGS[key as FeatureFlagKey];
						return `  • ${def.label} (${key}) — needs ${def.requires?.join(', ')}`;
					})
					.join('\n')
		);
	}

	return resolved as FeatureFlagState;
}

function categoryLabel(cat: string): string {
	const map: Record<string, string> = {
		sending: 'Sending',
		receiving: 'Receiving',
		ai: 'AI',
		integrations: 'Integrations',
		security: 'Security & scanning',
		deliverability: 'Analytics & deliverability',
		hosted: 'Hosted-mode',
	};
	return map[cat] ?? cat;
}

async function pickAIProvider(): Promise<EnvMap | null> {
	const provider = await select({
		message: 'AI provider',
		options: [
			{ label: 'OpenRouter (200+ models, recommended)', value: 'openrouter' },
			{ label: 'OpenAI', value: 'openai' },
			{ label: 'Ollama (local — bundled ollama service, no API key)', value: 'ollama' },
			{ label: 'Custom (Anthropic, Together, Groq, local LM Studio…)', value: 'custom' },
		],
	});
	if (isCancel(provider)) return null;

	if (provider === 'openrouter') {
		const apiKey = await password({ message: 'OpenRouter API key (sk-or-...)' });
		if (isCancel(apiKey)) return null;
		if (
			!(await validateWithSpinner('Validating OpenRouter key', () =>
				validateOpenRouterKey(apiKey as string)
			))
		) {
			return null;
		}
		return {
			LLM_PROVIDER: 'openrouter',
			LLM_API_KEY: apiKey as string,
			OPENROUTER_API_KEY: apiKey as string,
		};
	}

	if (provider === 'openai') {
		const apiKey = await password({ message: 'OpenAI API key (sk-...)' });
		if (isCancel(apiKey)) return null;
		if (
			!(await validateWithSpinner('Validating OpenAI key', () =>
				validateOpenAIKey(apiKey as string)
			))
		) {
			return null;
		}
		return {
			LLM_PROVIDER: 'openai',
			LLM_API_KEY: apiKey as string,
			OPENAI_API_KEY: apiKey as string,
		};
	}

	if (provider === 'ollama') {
		// Local model server — no key, no remote validation. The provider factory
		// resolves http://ollama:11434/v1 automatically when LLM_PROVIDER=ollama.
		// The bundled `ollama` service comes up under the same profile as the AI
		// worker; pull a model into it after boot (e.g. `docker compose exec ollama
		// ollama pull llama3.1`) and set LLM_MODEL_* to match.
		log.info(
			'Ollama runs locally on the internal Docker network (ollama:11434). No API key needed.\n' +
				'After the stack is up, pull a model into it, e.g.: docker compose exec ollama ollama pull llama3.1'
		);
		return {
			LLM_PROVIDER: 'ollama',
		};
	}

	if (provider === 'custom') {
		const result = await group({
			baseUrl: () =>
				text({
					message: 'OpenAI-compatible base URL',
					placeholder: 'https://api.anthropic.com/v1',
				}),
			apiKey: () => password({ message: 'API key' }),
			fast: () => text({ message: 'Fast model name', placeholder: 'claude-3-5-haiku' }),
			capable: () => text({ message: 'Capable model name', placeholder: 'claude-3-5-sonnet' }),
		});
		return {
			LLM_PROVIDER: 'custom',
			LLM_BASE_URL: result.baseUrl,
			LLM_API_KEY: result.apiKey,
			LLM_MODEL_FAST: result.fast,
			LLM_MODEL_CAPABLE: result.capable,
		};
	}

	return null;
}

async function collectGoogleSafeBrowsing(): Promise<EnvMap | null> {
	const apiKey = await password({ message: 'Google Safe Browsing API key' });
	if (isCancel(apiKey)) return null;
	if (
		!(await validateWithSpinner('Validating Google Safe Browsing key', () =>
			validateGoogleSafeBrowsingKey(apiKey as string)
		))
	) {
		return null;
	}
	return { GOOGLE_SAFE_BROWSING_API_KEY: apiKey as string };
}

async function collectPostHog(): Promise<EnvMap | null> {
	const result = await group({
		host: () => text({ message: 'PostHog host', placeholder: 'https://app.posthog.com' }),
		apiKey: () => password({ message: 'PostHog API key (phc_...)' }),
	});
	if (
		!(await validateWithSpinner('Checking PostHog reachability', () =>
			validatePostHogHost(result.host, result.apiKey)
		))
	) {
		return null;
	}
	return {
		POSTHOG_API_KEY: result.apiKey,
		POSTHOG_HOST: result.host,
		NUXT_PUBLIC_POSTHOG_API_KEY: result.apiKey,
		NUXT_PUBLIC_POSTHOG_HOST: result.host,
	};
}

async function collectAdmin(): Promise<{ email: string; name: string; password: string } | null> {
	const result = await group({
		email: () =>
			text({
				message: 'Admin email',
				validate: (v) => (isValidEmail(v ?? '') ? undefined : 'Enter a valid email'),
			}),
		name: () => text({ message: 'Admin display name' }),
		password: () => password({ message: 'Admin password (min 12 chars)', mask: '•' }),
	});
	if (!result.password || result.password.length < 12) {
		log.error('Password must be at least 12 characters.');
		return null;
	}
	return result as { email: string; name: string; password: string };
}

async function collectDomain(): Promise<EnvMap | null> {
	const result = await group({
		ehlo: () => text({ message: 'EHLO hostname', placeholder: 'mail.example.com' }),
		bounceDomain: () =>
			text({ message: 'Bounce / Return-Path domain', placeholder: 'bounces.example.com' }),
	});
	return {
		EHLO_HOSTNAME: result.ehlo,
		RETURN_PATH_DOMAIN: result.bounceDomain,
	};
}

async function launchWebWizard(opts: RunOptions): Promise<number> {
	log.info(`Booting the web wizard at ${pc.cyan('http://localhost:3000/setup')}…`);
	log.info(
		`Run ${pc.cyan('cd ' + opts.owlatDir + ' && owlat start')} in another shell, then visit the URL.`
	);
	log.info(
		`For SSH installs without a local browser, re-run with ${pc.cyan('--terminal')} to use the terminal wizard instead.`
	);

	// The actual bootstrap (docker compose up with profile=setup) is handled by
	// `owlat start` — this CLI's job is to prepare .env so apps/web can boot in
	// setup mode. We write a minimal placeholder so the stack can come up.
	const envPath = join(opts.owlatDir, '.env');
	const existing = await readEnv(envPath);
	const withSecrets = ensureSecrets(existing);
	withSecrets['OWLAT_DEPLOYMENT_MODE'] = 'selfhost';
	withSecrets['OWLAT_SETUP_MODE'] = 'true';
	await writeEnv(envPath, withSecrets);

	// Optionally try to open the browser when DISPLAY is available.
	if (process.env['DISPLAY'] || process.platform === 'darwin' || process.platform === 'win32') {
		try {
			const cmd =
				process.platform === 'darwin'
					? 'open'
					: process.platform === 'win32'
						? 'start'
						: 'xdg-open';
			spawn(cmd, ['http://localhost:3000/setup'], { stdio: 'ignore', detached: true }).unref();
		} catch {
			// Best-effort.
		}
	}

	outro(pc.green('Web wizard primed. Start the stack, then open the URL above.'));
	return 0;
}
