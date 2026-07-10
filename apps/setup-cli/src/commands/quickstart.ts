/**
 * `owlat-setup quickstart` — single command that takes a fresh clone to a
 * running self-hosted Docker app with an admin account and demo data.
 *
 * Composition (each step is idempotent so re-running is safe):
 *
 *   1. Sanity-check (in monorepo? Docker reachable?)
 *   2. Run the existing setup wizard if `.env` / override don't exist yet
 *   3. Prompt for mode: populated (default) | blank | custom
 *   4. `docker compose up -d` for the selfhost stack
 *   5. Wait for Convex backend to come up
 *   6. Bootstrap admin    (skipped in blank mode)
 *   7. Seed demo data     (skipped in blank mode)
 *   8. Print summary
 *
 * Non-interactive: --assume-yes + --mode + --email/--password/--no-seed for CI.
 */

import {
	intro,
	outro,
	select,
	isCancel,
	log,
	confirm,
	text,
	password as passwordPrompt,
} from '@clack/prompts';
import pc from 'picocolors';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { mergeEnv, readEnv, writeEnv } from '../lib/env';
import { waitForUrl } from '../lib/dockerHealth';
import {
	generateConvexAdminKey,
	deployConvexFunctions,
	setConvexEnvVars,
	selectRuntimeEnvVars,
	looksLikeRealAdminKey,
} from '../lib/convexDeploy';
import { createReporter, progressSpinner, SetupStep, type Reporter } from '../lib/progress';
import { resolveLocalUrls } from '../lib/localHost';
import { parseSetupConfig, type SetupConfig } from '../lib/setupConfig';
import { buildCaddyfile } from '../lib/caddyfile';
import { isValidEmail } from '../lib/validators';
import { runSetup } from './setup';
import { bootstrap } from './bootstrap-org';
import { runSeed } from './seed';
import type { CliOptions } from '../lib/cliOptions';

export type Mode = 'populated' | 'blank' | 'custom';

interface RunOptions extends CliOptions {
	/** Build the stack images from this source tree instead of pulling published tags. */
	buildLocal?: boolean;
	/** Use pre-pushed `dev`-tagged images as-is (built on the developer machine). */
	localImages?: boolean;
	/**
	 * Release version (bare semver, e.g. `1.2.3`) resolved by install.sh from the
	 * install ref. On the `curl | bash` PULL path this is pinned into `.env` as
	 * `OWLAT_VERSION` so compose interpolates the cosign-signed release images
	 * (`ghcr.io/.../<svc>:X.Y.Z`) instead of the never-pushed `:dev` sentinel.
	 */
	owlatVersion?: string;
}

export interface ParsedFlags {
	mode?: Mode;
	email?: string;
	name?: string;
	password?: string;
	skipSeed?: boolean;
	forceSeed?: boolean;
}

export async function runQuickstart(opts: RunOptions): Promise<number> {
	intro(pc.bgMagenta(pc.white(' Owlat Quickstart ')));

	const flags = parseFlags(opts.args);
	const reporter = createReporter();

	// A config file makes the whole run non-interactive (CI + the desktop app
	// driving a remote install over SSH): mode/bootstrap/seed are derived from it
	// rather than prompted, and the admin account comes from the file.
	let config: SetupConfig | null = null;
	if (opts.configFile) {
		try {
			config = parseSetupConfig(JSON.parse(await readFile(opts.configFile, 'utf-8')));
		} catch (e) {
			log.error(`Invalid setup config ${opts.configFile}: ${(e as Error).message}`);
			reporter.done(false);
			return 1;
		}
	}

	reporter.step(SetupStep.Preflight, 'Checking prerequisites');
	if (!verifyMonorepo(opts.owlatDir)) {
		reporter.fail(`No turbo.json at ${opts.owlatDir}`);
		log.error(
			`No turbo.json found at ${opts.owlatDir}. Run from the monorepo root or pass --owlat-dir.`
		);
		reporter.done(false);
		return 1;
	}

	if (!(await dockerReachable())) {
		reporter.fail('Docker daemon is not reachable');
		log.error(
			'Docker daemon is not reachable. Start Docker Desktop (or the daemon) and try again.'
		);
		reporter.done(false);
		return 1;
	}
	reporter.ok();

	// Step 2: env / override file — run existing setup wizard if missing.
	const envPath = join(opts.owlatDir, '.env');
	const overridePath = join(opts.owlatDir, 'docker-compose.override.yml');
	const envExists = existsSync(envPath) && Object.keys(await readEnv(envPath)).length > 0;
	const overrideExists = existsSync(overridePath);

	if (!envExists || !overrideExists) {
		log.info('No prior .env / override found — running the setup wizard first.');
		const exitCode = await runSetup(opts);
		if (exitCode !== 0) return exitCode;
	} else {
		log.success(`Reusing existing config at ${pc.cyan(envPath)}.`);
	}

	// Pin compose interpolation's OWLAT_VERSION into `.env` BEFORE the first
	// compose call — docker-compose.yml interpolates `${OWLAT_VERSION:-dev}` and,
	// left unset, would fall back to the never-pushed `:dev` sentinel and (because
	// every service also declares a `build:`) rebuild all images from source on
	// the box or hard-fail "manifest unknown". A release (`curl | bash`) install
	// pins the resolved semver so compose pulls the cosign-signed release images;
	// a local-source install pins `dev` to build from this tree / use pre-pushed
	// dev images. A branch/main/commit install has no matching immutable tag, so
	// nothing is written and the compose default (`dev` → build from source)
	// stands.
	const versionPin = resolveComposeVersionPin(opts);
	if (versionPin) {
		await writeEnv(envPath, mergeEnv(await readEnv(envPath), { OWLAT_VERSION: versionPin }));
		log.info(
			opts.buildLocal
				? 'Local build mode: stack images will be built from this source tree (OWLAT_VERSION=dev).'
				: opts.localImages
					? 'Local images mode: using pre-pushed dev images (OWLAT_VERSION=dev).'
					: `Pinned stack images to the signed release ${versionPin} (OWLAT_VERSION=${versionPin}).`
		);
	}

	// Step 3: mode + bootstrap/seed decisions. Derived from the config file when
	// present (non-interactive), otherwise prompted. The deploy step needs to
	// know whether demo-seeding is requested (it must enable OWLAT_DEV_MODE so the
	// /seed/demo endpoint is reachable).
	let mode: Mode;
	let shouldBootstrap: boolean;
	let shouldSeed: boolean;
	if (config) {
		shouldBootstrap = true;
		shouldSeed = config.seedDemo ?? false;
		mode = shouldSeed ? 'populated' : 'custom';
	} else {
		const picked = await pickMode(flags.mode, opts.assumeYes);
		if (picked === null) {
			outro(pc.yellow('Quickstart cancelled.'));
			return 0;
		}
		mode = picked;
		shouldBootstrap =
			mode !== 'blank' &&
			(mode === 'populated' || (await askYesNo('Bootstrap an admin user?', true, opts.assumeYes)));
		shouldSeed =
			mode !== 'blank' &&
			!flags.skipSeed &&
			(mode === 'populated' || (await askYesNo('Seed demo data?', true, opts.assumeYes)));
	}

	// Step 3c: edge TLS — when public URLs are configured, generate a Caddyfile
	// and enable the `tls` compose profile so the instance is reachable over
	// HTTPS off-box. The operator must point DNS at the box and open 80/443 for
	// Let's Encrypt to issue certs.
	const composeProfiles: string[] = [];
	if (config?.network) {
		try {
			const caddyfile = buildCaddyfile({
				webHost: new URL(config.network.siteUrl).hostname,
				convexHost: new URL(config.network.convexUrl).hostname,
				convexSiteHost: new URL(config.network.convexSiteUrl).hostname,
				email: config.admin.email,
			});
			await writeFile(join(opts.owlatDir, 'Caddyfile'), caddyfile, 'utf-8');
			composeProfiles.push('tls');
			reporter.log(`Configured TLS for ${new URL(config.network.siteUrl).hostname} (Caddy)`);
		} catch (e) {
			reporter.fail(`Could not write Caddyfile: ${(e as Error).message}`);
			reporter.done(false);
			return 1;
		}
	}

	// Step 4: docker compose up.
	// MERGE the TLS profile into whatever COMPOSE_PROFILES the .env already
	// declares (the default self-host ships `mta`) rather than replacing it.
	// docker compose reads COMPOSE_PROFILES from .env, and the built-in MTA is
	// now an opt-in profile, so overwriting it with just `tls` would silently
	// drop the MTA (and any other feature profile) and break mail. Persist the
	// union into .env FIRST so the updater sidecar, manual `docker compose up`,
	// and scripts/restore.sh keep the same services; the process-env copy below
	// covers this immediate bring-up.
	const envForProfiles = await readEnv(envPath);
	const existingProfiles = (envForProfiles['COMPOSE_PROFILES'] ?? '')
		.split(',')
		.map((p) => p.trim())
		.filter(Boolean);
	const composeProfilesUnion = Array.from(new Set([...existingProfiles, ...composeProfiles]));
	if (composeProfilesUnion.length) {
		await writeEnv(
			envPath,
			mergeEnv(envForProfiles, { COMPOSE_PROFILES: composeProfilesUnion.join(',') })
		);
	}
	reporter.step(SetupStep.ComposeUp, 'Starting containers');
	const upCode = await dockerComposeUp(
		opts.owlatDir,
		composeProfilesUnion,
		opts.buildLocal ?? false
	);
	if (upCode !== 0) {
		reporter.fail(`docker compose up failed (exit ${upCode})`);
		reporter.done(false);
		return upCode;
	}
	reporter.ok('Stack is up');

	// Step 5: wait for the Convex backend's sync/`/version` endpoint — served on
	// the CLOUD port (3210). The application `http.route` handlers (/seed/*,
	// tracking, webhooks) live on the SITE proxy (3211) and only exist AFTER
	// functions are deployed, so we probe the cloud port here.
	const env = await readEnv(envPath);
	// The installer runs ON the box, so it always talks to the backend over the
	// published host ports (3210 cloud / 3211 site). HOW it addresses them
	// depends on the container network: under Linux host networking the wizard
	// shares the host loopback so `localhost` works; under Docker Desktop
	// (macOS/Windows) it runs on the bridge and scripts/owlat sets
	// OWLAT_LOCAL_HOST=host.docker.internal. resolveLocalUrls() defaults to
	// 'localhost' so the blessed Linux path is unchanged, and still ignores the
	// PUBLIC NUXT_PUBLIC_* / CONVEX_SITE_URL values for a domain install (they
	// aren't reachable on-box until DNS + TLS are live). See lib/localHost.ts.
	const { localCloud, localSite } = resolveLocalUrls({ network: Boolean(config?.network), env });
	const s = progressSpinner();
	reporter.step(SetupStep.WaitConvex, `Waiting for Convex at ${localCloud}`);
	s.start(`Waiting for Convex at ${localCloud}`);
	try {
		await waitForUrl({ url: `${localCloud}/version`, timeoutMs: 120_000 });
		s.stop(pc.green('Convex backend is up'));
		reporter.ok('Convex backend is up');
	} catch (e) {
		s.stop(pc.red(`Convex did not come up: ${(e as Error).message}`));
		log.error('Check `docker compose logs convex` for details.');
		reporter.fail((e as Error).message);
		reporter.done(false);
		return 1;
	}

	// Step 5b: deploy functions + push function-runtime env vars. A fresh
	// backend boots EMPTY — without this, no app functions exist, BetterAuth has
	// no secret, and the /seed/* routes 404. This is the step the old CLI was
	// missing entirely.
	const deployCode = await deployBackend(
		opts.owlatDir,
		envPath,
		shouldSeed,
		reporter,
		opts.buildLocal ?? false
	);
	if (deployCode !== 0) {
		reporter.done(false);
		return deployCode;
	}

	// Step 5c: wait for the SITE proxy to serve the freshly-deployed routes
	// before bootstrap/seed POST to them.
	reporter.step(SetupStep.WaitRoutes, `Waiting for Convex HTTP routes at ${localSite}`);
	s.start(`Waiting for Convex HTTP routes at ${localSite}`);
	try {
		await waitForUrl({ url: `${localSite}/api/v1/health`, timeoutMs: 60_000 });
		s.stop(pc.green('Convex HTTP routes are live'));
		reporter.ok('HTTP routes are live');
	} catch {
		s.stop(pc.yellow('HTTP routes still warming up — continuing (bootstrap will retry).'));
		reporter.warn('HTTP routes still warming up — continuing');
	}

	let adminEmail: string | undefined;
	reporter.step(SetupStep.BootstrapAdmin, 'Creating the admin account');
	if (shouldBootstrap) {
		const email =
			config?.admin.email ??
			flags.email ??
			(opts.assumeYes ? 'dev@example.com' : await promptEmail());
		if (!email) {
			reporter.fail('No admin email provided');
			reporter.done(false);
			return 1;
		}
		const name =
			config?.admin.name ??
			flags.name ??
			(opts.assumeYes ? 'Dev Admin' : await promptText('Admin display name'));
		if (!name) {
			reporter.fail('No admin name provided');
			reporter.done(false);
			return 1;
		}
		const password =
			config?.admin.password ??
			flags.password ??
			(opts.assumeYes ? 'devpassword12345' : await promptPassword());
		if (!password) {
			reporter.fail('No admin password provided');
			reporter.done(false);
			return 1;
		}

		const exit = await bootstrap(
			{ email, name, password },
			opts,
			config?.network ? localSite : undefined
		);
		if (exit !== 0) {
			reporter.fail('Admin bootstrap failed');
			reporter.done(false);
			return exit;
		}
		reporter.ok(`Admin ${email} created`);
		adminEmail = email;
	} else {
		reporter.skip('blank mode — no admin created');
	}

	reporter.step(SetupStep.SeedDemo, 'Seeding demo data');
	if (shouldSeed) {
		const exit = await runSeed(
			{ ...opts, positional: [] },
			config?.network ? localSite : undefined
		);
		if (exit !== 0) {
			reporter.fail('Demo seed failed');
			reporter.done(false);
			return exit;
		}
		reporter.ok();
	} else {
		reporter.skip('not requested');
	}

	// Domain installs only work once the operator creates the DNS records —
	// spell out exactly which ones (also emitted as log lines so the desktop
	// installer surfaces them in its drawer).
	if (config?.network) {
		for (const line of dnsInstructions(config)) {
			reporter.log(line);
			log.info(line);
		}
	}

	// Step 8: summary.
	reporter.done(true, {
		mode,
		adminEmail,
		siteUrl: env['SITE_URL'] || 'http://localhost:3000',
		convexUrl: env['NUXT_PUBLIC_CONVEX_URL'] || localCloud,
		convexSiteUrl: env['NUXT_PUBLIC_CONVEX_SITE_URL'] || env['CONVEX_SITE_URL'] || localSite,
	});
	outro(formatSummary({ mode, adminEmail, baseUrl: env['NUXT_PUBLIC_CONVEX_URL'] || localCloud }));
	return 0;
}

/**
 * The DNS records a domain install needs before its public URLs work. The
 * server's own public IP isn't reliably known from inside the box, so the
 * target is described rather than printed.
 */
export function dnsInstructions(config: SetupConfig): string[] {
	if (!config.network) return [];
	const hosts = [
		config.network.siteUrl,
		config.network.convexUrl,
		config.network.convexSiteUrl,
	].map((u) => new URL(u).hostname);
	const pad = Math.max(...hosts.map((h) => h.length)) + 2;
	const lines = [
		"DNS records required for public access (point them at this server's public IP):",
		...hosts.map((h) => `  ${h.padEnd(pad)}A    <server IP>`),
	];
	if (config.sending?.provider === 'mta' && config.domain) {
		lines.push(
			`  ${config.domain.ehloHostname.padEnd(pad)}A    <server IP>  (+ matching PTR via your host)`,
			...(config.domain.bounceDomain
				? [`  ${config.domain.bounceDomain.padEnd(pad)}MX   ${config.domain.ehloHostname}`]
				: [])
		);
	}
	lines.push(
		'TLS certificates are issued automatically once DNS resolves; keep ports 80/443 open.'
	);
	return lines;
}

/**
 * Turn the EMPTY freshly-booted backend into a working deployment:
 *   1. mint the backend admin key (if not already real) and persist to .env
 *   2. deploy apps/api functions + schema + http routes
 *   3. enable OWLAT_DEV_MODE when demo-seeding (so /seed/demo isn't fail-closed)
 *   4. push the function-runtime env vars into the deployment
 *
 * Steps 2–4 run through the `convex-deploy` container, which reads the admin
 * key from .env (compose interpolation) — hence step 1 writes it first.
 */
async function deployBackend(
	owlatDir: string,
	envPath: string,
	seeding: boolean,
	reporter: Reporter,
	buildLocal = false
): Promise<number> {
	const s = progressSpinner();

	// 1. Admin key — must be issued by the running backend.
	let env = await readEnv(envPath);
	reporter.step(SetupStep.AdminKey, 'Minting the Convex admin key');
	if (!looksLikeRealAdminKey(env['CONVEX_ADMIN_KEY'])) {
		s.start('Generating Convex admin key from the backend');
		try {
			const key = await generateConvexAdminKey(owlatDir);
			env = { ...env, CONVEX_ADMIN_KEY: key };
			await writeEnv(envPath, env);
			s.stop(pc.green('Admin key generated and saved to .env'));
			reporter.ok();
		} catch (e) {
			s.stop(pc.red(`Could not generate admin key: ${(e as Error).message}`));
			reporter.fail((e as Error).message);
			return 1;
		}
	} else {
		reporter.skip('already present in .env');
	}

	// 2. Deploy functions.
	reporter.step(SetupStep.DeployFunctions, 'Deploying backend functions');
	s.start('Deploying Convex functions (apps/api) — first run pulls/builds the deployer image');
	try {
		// buildLocal: the deployer image is built from source here; the later
		// env-set call reuses it (compose only pulls when the image is missing).
		await deployConvexFunctions(
			owlatDir,
			(line) => {
				s.message(line.slice(0, 80));
				reporter.log(line);
			},
			buildLocal
		);
		s.stop(pc.green('Convex functions deployed'));
		reporter.ok();
	} catch (e) {
		s.stop(pc.red(`${(e as Error).message}`));
		reporter.fail((e as Error).message);
		return 1;
	}

	// 3. Enable dev endpoints when seeding (otherwise /seed/demo is fail-closed).
	if (seeding && env['OWLAT_DEV_MODE']?.toLowerCase() !== 'true') {
		env = { ...env, OWLAT_DEV_MODE: 'true' };
		await writeEnv(envPath, env);
	}

	// 4. Push function-runtime env vars into the deployment.
	const runtimeVars = selectRuntimeEnvVars(env);
	reporter.step(SetupStep.EnvSet, `Setting ${runtimeVars.length} function-runtime env var(s)`);
	s.start(`Setting ${runtimeVars.length} Convex function-runtime env var(s)`);
	try {
		await setConvexEnvVars(owlatDir, runtimeVars, (line) => reporter.log(line));
		s.stop(pc.green('Function-runtime env vars set'));
		reporter.ok();
	} catch (e) {
		s.stop(pc.red(`${(e as Error).message}`));
		reporter.fail((e as Error).message);
		return 1;
	}

	return 0;
}

/**
 * Decide the `OWLAT_VERSION` value to pin into `.env` for compose interpolation
 * BEFORE the first `docker compose up`, or `undefined` to leave it unset.
 *
 *   - Local-source installs (`buildLocal` / `localImages`) pin the `dev`
 *     sentinel so compose builds from this tree / uses pre-pushed dev images.
 *   - A release install threads the resolved semver (e.g. `1.2.3`) through from
 *     install.sh; pinning it makes compose pull the cosign-signed release
 *     images (`ghcr.io/.../<svc>:X.Y.Z`) rather than the never-pushed `:dev`
 *     sentinel — which would otherwise rebuild every image from source or fail
 *     "manifest unknown".
 *   - A branch/`main`/commit install has no matching immutable image tag, so
 *     return `undefined` and let the compose default (`dev` → build from
 *     source) stand.
 */
export function resolveComposeVersionPin(opts: {
	buildLocal?: boolean;
	localImages?: boolean;
	owlatVersion?: string;
}): string | undefined {
	if (opts.buildLocal || opts.localImages) return 'dev';
	const version = opts.owlatVersion?.trim();
	// Only a bare semver corresponds to a published, signed release image tag.
	if (version && /^\d+\.\d+\.\d+/.test(version)) return version;
	return undefined;
}

export function parseFlags(args: string[]): ParsedFlags {
	const out: ParsedFlags = {};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (!arg.startsWith('--')) continue;
		const eq = arg.indexOf('=');
		const [k, raw] = eq === -1 ? [arg, args[i + 1]] : [arg.slice(0, eq), arg.slice(eq + 1)];
		if (k === '--mode' && (raw === 'populated' || raw === 'blank' || raw === 'custom'))
			out.mode = raw;
		else if (k === '--email') out.email = raw;
		else if (k === '--name') out.name = raw;
		else if (k === '--password') out.password = raw;
		else if (k === '--no-seed') out.skipSeed = true;
		else if (k === '--seed') out.forceSeed = true;
	}
	return out;
}

function verifyMonorepo(dir: string): boolean {
	return existsSync(join(dir, 'turbo.json'));
}

async function dockerReachable(): Promise<boolean> {
	return new Promise((resolve) => {
		const proc = spawn('docker', ['info'], { stdio: 'ignore' });
		proc.on('close', (code) => resolve(code === 0));
		proc.on('error', () => resolve(false));
	});
}

async function dockerComposeUp(
	cwd: string,
	profiles: string[] = [],
	build = false
): Promise<number> {
	const s = progressSpinner();
	s.start(
		build
			? 'Running `docker compose up -d --build` (building images from source — this can take several minutes)'
			: 'Running `docker compose up -d` (this may take a minute on first run)'
	);
	// COMPOSE_PROFILES activates optional services (e.g. `tls` for the Caddy edge
	// proxy on a domain install) for this bring-up.
	const env = profiles.length
		? { ...process.env, COMPOSE_PROFILES: profiles.join(',') }
		: undefined;
	const code = await spawnExitCode(
		'docker',
		['compose', 'up', '-d', ...(build ? ['--build'] : [])],
		{ cwd, env }
	);
	if (code !== 0) {
		s.stop(pc.red(`docker compose up failed with exit code ${code}`));
		return code;
	}
	s.stop(pc.green('Stack is up'));
	return 0;
}

function spawnExitCode(
	cmd: string,
	args: string[],
	opts: { cwd: string; env?: NodeJS.ProcessEnv }
): Promise<number> {
	return new Promise((resolve) => {
		const proc = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: 'inherit' });
		proc.on('close', (code) => resolve(code ?? 1));
		proc.on('error', () => resolve(1));
	});
}

async function pickMode(fromFlag: Mode | undefined, assumeYes: boolean): Promise<Mode | null> {
	if (fromFlag) return fromFlag;
	if (assumeYes) return 'populated';
	const options: Array<{ label: string; value: Mode; hint?: string }> = [
		{
			label: 'Populated — admin + realistic demo data',
			value: 'populated',
			hint: 'recommended for working on existing features',
		},
		{
			label: 'Blank — no admin, no data',
			value: 'blank',
			hint: 'test the real /auth/register signup flow',
		},
		{
			label: 'Custom — decide per step',
			value: 'custom',
		},
	];
	const choice = await select({
		message: 'What kind of dev environment do you want?',
		options,
		initialValue: 'populated',
	});
	if (isCancel(choice)) return null;
	return choice as Mode;
}

async function askYesNo(message: string, initial: boolean, assumeYes: boolean): Promise<boolean> {
	if (assumeYes) return initial;
	const result = await confirm({ message, initialValue: initial });
	if (isCancel(result)) return false;
	return result;
}

async function promptEmail(): Promise<string | undefined> {
	const result = await text({
		message: 'Admin email',
		validate: (v) => (isValidEmail(v ?? '') ? undefined : 'Enter a valid email'),
	});
	if (isCancel(result)) return undefined;
	return result;
}

async function promptText(message: string): Promise<string | undefined> {
	const result = await text({ message });
	if (isCancel(result)) return undefined;
	return result;
}

async function promptPassword(): Promise<string | undefined> {
	const result = await passwordPrompt({
		message: 'Admin password (min 12 chars)',
		validate: (v) =>
			(v ?? '').length < 12 ? 'Password must be at least 12 characters' : undefined,
		mask: '•',
	});
	if (isCancel(result)) return undefined;
	return result;
}

export function formatSummary(args: { mode: Mode; adminEmail?: string; baseUrl: string }): string {
	const lines: string[] = [pc.green('Quickstart complete!')];
	lines.push('');
	lines.push(`Web app:   ${pc.cyan('http://localhost:3000')}`);
	lines.push(`Convex:    ${pc.cyan(args.baseUrl)}`);
	if (args.mode === 'blank') {
		lines.push(`Mode:      ${pc.yellow('Blank — sign up at /auth/register')}`);
	} else if (args.adminEmail) {
		lines.push(`Admin:     ${pc.cyan(args.adminEmail)}`);
	}
	lines.push('');
	lines.push(pc.dim('View logs:  docker compose logs -f web'));
	lines.push(pc.dim('Re-seed:    bunx owlat-setup seed --reset'));
	lines.push(pc.dim('Wipe + retest signup:  bunx owlat-setup reset'));
	// Backups are operator-owned: there is no managed/off-box backup, so always
	// spell out the command and what it protects. This block must stay even in
	// blank mode — a fresh install finishing with no backup plan is the gap.
	lines.push('');
	lines.push(
		pc.bold('Back up your data — nothing is backed up automatically until you turn it on:')
	);
	lines.push(
		`  ${pc.cyan('owlat backup')}                  one-off snapshot of the Convex data volume (your database), Redis + .env`
	);
	lines.push(
		`  ${pc.cyan('owlat backup-schedule enable')}  schedule automatic backups (daily; systemd timer, cron fallback)`
	);
	lines.push(
		pc.dim(
			'  Recommended: run "owlat backup-schedule enable" for daily backups before you put real data in.'
		)
	);
	return lines.join('\n');
}
