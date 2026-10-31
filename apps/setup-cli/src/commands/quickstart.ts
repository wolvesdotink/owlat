/**
 * `owlat-setup quickstart` — single command that takes a fresh clone to a
 * running self-hosted Docker app with an admin account and demo data.
 *
 * Composition (each step is idempotent so re-running is safe):
 *
 *   1. Sanity-check (in monorepo? Docker reachable?)
 *   2. Run the existing setup wizard if `.env` / override don't exist yet
 *   3. Prompt for mode: populated / "explore with sample data" (default) |
 *      blank | custom
 *   4. `docker compose up -d` for the selfhost stack
 *   5. Wait for Convex backend to come up
 *   6. Bootstrap admin    (skipped in blank mode)
 *   7. Install sample data (skipped in blank mode; POST /sample-data/install,
 *      or the fuller dev-only /seed/demo when OWLAT_DEV_MODE is already on)
 *   8. Print summary
 *
 * Non-interactive: --assume-yes + --mode + --email/--password/--no-seed for CI.
 */

import { intro, outro, log } from '@clack/prompts';
import pc from 'picocolors';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { mergeEnv, readEnv, writeEnv } from '../lib/env';
import { waitForUrl } from '../lib/dockerHealth';
import { createReporter, progressSpinner, SetupStep } from '../lib/progress';
import { resolveLocalUrls } from '../lib/localHost';
import { parseSetupConfig, type SetupConfig } from '../lib/setupConfig';
import { buildCaddyfile } from '../lib/caddyfile';
import { runSetup } from './setup';
import { bootstrap, resolveAdminPassword } from './bootstrap-org';
import { runSeed } from './seed';
import { installSampleData } from './sampleData';
import type { CliOptions } from '../lib/cliOptions';
import { ProvisioningCheckpoint, type CheckpointInputs } from '../lib/provisioningCheckpoint';
import {
	askYesNo,
	dnsInstructions,
	formatSummary,
	parseFlags,
	pickMode,
	promptEmail,
	promptText,
	type Mode,
} from './quickstartPrompts';
import {
	composeImageSource,
	dockerComposeUp,
	dockerReachable,
	prepareComposeProfiles,
	resolveComposeVersionPin,
	resolveSourceRevision,
	verifyMonorepo,
} from './quickstartStack';
import { deployBackend, verifyMtaIdentity } from './quickstartBackend';

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
	// present (non-interactive), otherwise prompted. Sample data is opt-in and
	// reversible in one command (`owlat sample-data remove`), so a real install
	// can say yes here without committing to demo rows forever.
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
			(mode === 'populated' ||
				(await askYesNo(
					'Explore with sample data? (removable later with `owlat sample-data remove`)',
					true,
					opts.assumeYes
				)));
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

	// Step 4: docker compose up, with the profiles persisted and the sending
	// pools readied first (prepareComposeProfiles).
	const composeProfilesUnion = await prepareComposeProfiles(
		envPath,
		composeProfiles,
		reporter,
		!opts.assumeYes && !config && !reporter.isJson
	);

	const knownAdminEmail = shouldBootstrap
		? (config?.admin.email ?? flags.email ?? (opts.assumeYes ? 'dev@example.com' : undefined))
		: undefined;
	const checkpointInputs: CheckpointInputs = {
		mode,
		shouldBootstrap,
		shouldSeed,
		...(knownAdminEmail ? { adminEmail: knownAdminEmail } : {}),
		...(versionPin ? { version: versionPin } : {}),
		buildLocal: opts.buildLocal ?? false,
		localImages: opts.localImages ?? false,
		composeProfiles: composeProfilesUnion,
		...(await resolveSourceRevision(opts.owlatDir)),
		...(config?.network ? { network: config.network } : {}),
		...(config?.sending
			? {
					sending: {
						provider: config.sending.provider,
						...(config.domain ? { domain: config.domain.ehloHostname } : {}),
					},
				}
			: {}),
	};
	const checkpoint = await ProvisioningCheckpoint.open({
		owlatDir: opts.owlatDir,
		inputs: checkpointInputs,
		restart: flags.restart,
	});
	const completed = checkpoint.completedSteps();
	if (completed.length > 0) {
		log.info(`Resuming provisioning after ${completed.length} completed step(s).`);
	}
	reporter.step(SetupStep.ComposeUp, 'Starting containers');
	const upCode = await dockerComposeUp(
		opts.owlatDir,
		composeProfilesUnion,
		composeImageSource(opts)
	);
	if (upCode !== 0) {
		reporter.fail(`docker compose up failed (exit ${upCode})`);
		reporter.done(false);
		return upCode;
	}
	reporter.ok('Stack is up');
	await checkpoint.complete('compose-up');

	const envAfterCompose = await readEnv(envPath);
	if (
		composeProfilesUnion.includes('mta') &&
		!(await verifyMtaIdentity(envAfterCompose, reporter))
	) {
		return 1;
	}

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
		await checkpoint.complete('convex-ready');
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
		reporter,
		opts.buildLocal ?? false,
		checkpoint,
		composeProfilesUnion
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
		await checkpoint.complete('routes-ready');
	} catch {
		s.stop(pc.yellow('HTTP routes still warming up — continuing (bootstrap will retry).'));
		reporter.warn('HTTP routes still warming up — continuing');
	}

	let adminEmail: string | undefined;
	reporter.step(SetupStep.BootstrapAdmin, 'Creating the admin account');
	if (shouldBootstrap) {
		if (checkpoint.isComplete('bootstrap-admin') && knownAdminEmail) {
			reporter.skip('completed in an earlier run');
			adminEmail = knownAdminEmail;
		} else {
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
				(await resolveAdminPassword(Boolean(opts.assumeYes)));
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
			await checkpoint.complete('bootstrap-admin');
		}
	} else {
		reporter.skip('blank mode — no admin created');
	}

	reporter.step(SetupStep.SeedDemo, 'Seeding demo data');
	if (shouldSeed) {
		if (checkpoint.isComplete('seed-demo')) {
			reporter.skip('completed in an earlier run');
		} else {
			// A REAL install gets the sample-data path: the same content, minus the
			// dummy teammate sign-ins (published password hashes) and their hosted
			// mailboxes, over an endpoint that needs no OWLAT_DEV_MODE. A local dev
			// deployment — one that already opted into the dev endpoints — keeps the
			// fuller /seed/demo dataset, teammates and Postbox threads included.
			const devEndpointsEnabled = env['OWLAT_DEV_MODE']?.toLowerCase() === 'true';
			const seed = devEndpointsEnabled ? runSeed : installSampleData;
			const exit = await seed({ ...opts, positional: [] }, config?.network ? localSite : undefined);
			if (exit !== 0) {
				reporter.fail('Demo seed failed');
				reporter.done(false);
				return exit;
			}
			reporter.ok();
			await checkpoint.complete('seed-demo');
		}
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
