/**
 * The Docker side of `owlat-setup quickstart`: preflight checks, the compose
 * profiles and image source the stack comes up with, and the `docker compose`
 * calls themselves.
 */

import pc from 'picocolors';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { mergeEnv, readEnv, writeEnv } from '../lib/env';
import { progressSpinner, type Reporter } from '../lib/progress';
import { applyOutboundIpDefaults, detectPrimaryIpv4 } from '../lib/outboundIp';
import { announceReverseDns, plannedOutboundIdentities } from '../lib/reverseDns';

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

/** The compose profiles the stack comes up with, persisted to `.env`. */
export async function persistComposeProfiles(
	envPath: string,
	composeProfiles: string[]
): Promise<string[]> {
	// MERGE the TLS profile into whatever COMPOSE_PROFILES the .env already
	// declares (the default self-host ships `mta`) rather than replacing it.
	// docker compose reads COMPOSE_PROFILES from .env, and the built-in MTA is
	// now an opt-in profile, so overwriting it with just `tls` would silently
	// drop the MTA (and any other feature profile) and break mail. Persist the
	// union into .env FIRST so the updater sidecar, manual `docker compose up`,
	// and scripts/restore.sh keep the same services; the process-env copy in
	// dockerComposeUp covers this immediate bring-up.
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
	return composeProfilesUnion;
}

/**
 * Default the built-in MTA's sending pools to this box and ask for the
 * reverse DNS record before the stack comes up.
 */
export async function defaultSendingPools(
	envPath: string,
	reporter: Reporter,
	interactive: boolean
): Promise<void> {
	// Direct delivery needs a real source address. docker-compose.yml defaults
	// IP_POOLS_* to 127.0.0.1, whose PTR can never match EHLO_HOSTNAME, so the
	// MTA's identity gate (verifyMtaIdentity) would always fail. Default both
	// pools to the box's primary IPv4 unless the operator already chose one.
	const envForPools = await readEnv(envPath);
	const detected = detectPrimaryIpv4();
	if (applyOutboundIpDefaults(envForPools, detected)) {
		await writeEnv(envPath, envForPools);
		reporter.log(`Sending pools default to this server's address ${detected}`);
	} else if (!detected && !envForPools['IP_POOLS_TRANSACTIONAL']) {
		reporter.log(
			'Could not detect a routable IPv4 for the sending pools; set IP_POOLS_TRANSACTIONAL and IP_POOLS_CAMPAIGN in .env',
			'stderr'
		);
	}
	// Reverse DNS is the one record the installer cannot create on the
	// operator's behalf, and the MTA identity gate (verifyMtaIdentity) refuses
	// to let the stack finish without it. Ask for it HERE — before anything comes up —
	// so a missing PTR is a five-minute detour through the provider console
	// instead of an install that dies on `FCrDNS blocked for <ip>` having never
	// mentioned the record existed.
	await announceReverseDns(plannedOutboundIdentities(envForPools), envForPools, {
		// A config-file, --assume-yes or machine-driven run has nobody at the
		// keyboard to go set the record; it gets the same instructions, without
		// the re-check prompt (which would hang a non-TTY install forever).
		interactive,
		emit: (line, stream) => reporter.log(line, stream),
	});
}

export async function resolveSourceRevision(
	owlatDir: string
): Promise<{ sourceRevision?: string }> {
	return new Promise((resolve) => {
		const proc = spawn('git', ['rev-parse', 'HEAD'], {
			cwd: owlatDir,
			stdio: ['ignore', 'pipe', 'ignore'],
		});
		let stdout = '';
		proc.stdout?.on('data', (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		proc.on('close', (code) => {
			const revision = stdout.trim();
			resolve(code === 0 && revision ? { sourceRevision: revision } : {});
		});
		proc.on('error', () => resolve({}));
	});
}

export function verifyMonorepo(dir: string): boolean {
	return existsSync(join(dir, 'turbo.json'));
}

export async function dockerReachable(): Promise<boolean> {
	return new Promise((resolve) => {
		const proc = spawn('docker', ['info'], { stdio: 'ignore' });
		proc.on('close', (code) => resolve(code === 0));
		proc.on('error', () => resolve(false));
	});
}

/**
 * Where the first bring-up gets the first-party images from: `build` from this
 * source tree (`--build-local`), `preloaded` (`--local-images`: the desktop
 * built them elsewhere and loaded them onto this host, under a `dev` tag no
 * registry has), or the compose default (`pull`, or build what has no tag).
 */
export type ComposeImageSource = 'build' | 'preloaded' | 'default';

export function composeImageSource(opts: {
	buildLocal?: boolean;
	localImages?: boolean;
}): ComposeImageSource {
	if (opts.buildLocal) return 'build';
	if (opts.localImages) return 'preloaded';
	return 'default';
}

/**
 * The `docker compose up` arguments for an image source. Preloaded images must
 * never be rebuilt here: the local-images install exists for hosts that cannot
 * afford the build, so a missing image fails the run (with compose naming it)
 * instead of silently starting a build.
 */
export function composeUpArgs(source: ComposeImageSource): string[] {
	if (source === 'build') return ['compose', 'up', '-d', '--build'];
	if (source === 'preloaded') return ['compose', 'up', '-d', '--no-build'];
	return ['compose', 'up', '-d'];
}

export async function dockerComposeUp(
	cwd: string,
	profiles: string[] = [],
	source: ComposeImageSource = 'default'
): Promise<number> {
	const s = progressSpinner();
	s.start(
		source === 'build'
			? 'Running `docker compose up -d --build` (building images from source — this can take several minutes)'
			: 'Running `docker compose up -d` (this may take a minute on first run)'
	);
	// COMPOSE_PROFILES activates optional services (e.g. `tls` for the Caddy edge
	// proxy on a domain install) for this bring-up.
	const env = profiles.length
		? { ...process.env, COMPOSE_PROFILES: profiles.join(',') }
		: undefined;
	const code = await spawnExitCode('docker', composeUpArgs(source), { cwd, env });
	if (code !== 0) {
		s.stop(pc.red(`docker compose up failed with exit code ${code}`));
		return code;
	}
	s.stop(pc.green('Stack is up'));
	return 0;
}

/**
 * Re-apply `.env` to the already-running stack after the Convex admin key lands.
 *
 * The stack's first `docker compose up` necessarily happens BEFORE the admin key
 * exists: only an already-running backend can mint it (`generateConvexAdminKey`),
 * and `ensureSecrets` deliberately refuses to fabricate one. Docker bakes a
 * container's environment at CREATE time, so every service that consumes the key
 * — imap, mail-sync, convex-fn-proxy — was created holding an EMPTY one. Each of
 * those throws `CONVEX_ADMIN_KEY is required` on boot and, under
 * `restart: unless-stopped`, crash-loops on it forever. Nothing else in the run
 * touches them again (the remaining compose calls are one-shot
 * `run --rm convex-deploy`), so without this step a fresh install with Postbox or
 * external mail enabled ships a permanently broken container. A live instance
 * burnt 11h that way before anyone noticed.
 *
 * A second plain `up -d` is the whole fix, and `--force-recreate` is deliberately
 * NOT used: compose compares each service's config hash against its running
 * container and recreates only those whose resolved environment actually changed.
 * That is exactly the key consumers. `convex` — which we just waited to become
 * healthy — keeps its hash and is left alone.
 *
 * Non-fatal: the key is already persisted, so a failure here is fully recoverable
 * with `owlat start`, and aborting mid-deploy would be worse than reporting it.
 */
export async function reapplyEnvToRunningStack(cwd: string, profiles: string[]): Promise<void> {
	const s = progressSpinner();
	s.start('Applying the admin key to containers created before it existed');
	const env = profiles.length
		? { ...process.env, COMPOSE_PROFILES: profiles.join(',') }
		: undefined;
	const code = await spawnExitCode('docker', ['compose', 'up', '-d'], { cwd, env });
	if (code !== 0) {
		s.stop(
			pc.yellow(
				`Could not re-apply .env to the running stack (exit ${code}). Services that need ` +
					'the admin key (imap, mail-sync) may crash-loop until you run `owlat start`.'
			)
		);
		return;
	}
	s.stop(pc.green('Admin key applied to the running stack'));
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
