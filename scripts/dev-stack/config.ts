/**
 * Where one checkout's local dev stack lives: its identity, its port offset,
 * every host port and URL derived from that offset, and the Compose project
 * that scopes its containers and volumes.
 *
 * Pure (no I/O beyond what the caller passes in), so the resolver is unit
 * tested and shared by `scripts/dev-stack.ts`, `scripts/dev-seed.ts` and
 * `scripts/setup-worktree.ts` without them drifting apart.
 */

import { createHash } from 'node:crypto';
import { basename } from 'node:path';

/**
 * The canonical port of every service a local stack may bind on the host.
 * Offset 0 reproduces these exactly, so the main checkout keeps the ports
 * `.env.example` and the docs name. `mta` and `mailSync` are not started by
 * the stack; their ports are reserved so a worker run by hand next to it
 * cannot collide with another checkout's.
 */
export const BASE_PORTS = {
	web: 3000,
	mta: 3100,
	mailSync: 3200,
	convex: 3210,
	convexSite: 3211,
	redis: 6379,
} as const;

export type DevService = keyof typeof BASE_PORTS;
export type DevPorts = Record<DevService, number>;

/**
 * Hashed offsets are `OFFSET_MIN + OFFSET_STRIDE * slot`. The stride divides
 * no difference between two base ports, so two checkouts on different slots
 * can never put two different services on the same port (one checkout's
 * `convex` on another's `mailSync`, say). Only an identical slot collides,
 * and the runner detects that before binding. Adding a service whose base
 * breaks this property fails the resolver's tests.
 */
export const OFFSET_STRIDE = 13;
export const OFFSET_MIN = 10_000;
/**
 * Hashed ports stay below the Linux ephemeral range (32768+), where the
 * kernel hands out source ports for outgoing connections and a free port can
 * be taken between the check and the bind.
 */
const HASHED_PORT_CEILING = 32_767;
const MAX_PORT = 65_535;

const MAX_BASE_PORT = Math.max(...Object.values(BASE_PORTS));
export const OFFSET_SLOTS =
	Math.floor((HASHED_PORT_CEILING - MAX_BASE_PORT - OFFSET_MIN) / OFFSET_STRIDE) + 1;
export const MAX_EXPLICIT_OFFSET = MAX_PORT - MAX_BASE_PORT;

export class DevStackConfigError extends Error {}

export interface OffsetInput {
	/** Raw `OWLAT_PORT_OFFSET`, if set. Wins over everything else. */
	readonly explicit: string | undefined;
	/** Absolute, symlink-resolved checkout root. */
	readonly root: string;
	/** True for a `git worktree add` checkout (its `.git` is a file). */
	readonly linkedWorktree: boolean;
}

export interface ResolvedOffset {
	readonly offset: number;
	readonly source: string;
}

function rootHash(root: string): string {
	return createHash('sha256').update(root).digest('hex');
}

export function resolvePortOffset(input: OffsetInput): ResolvedOffset {
	const raw = input.explicit?.trim();
	if (raw !== undefined && raw !== '') {
		if (!/^\d+$/.test(raw)) {
			throw new DevStackConfigError(
				`OWLAT_PORT_OFFSET must be a whole number from 0 to ${MAX_EXPLICIT_OFFSET}, got "${raw}".`
			);
		}
		const offset = Number(raw);
		if (offset > MAX_EXPLICIT_OFFSET) {
			throw new DevStackConfigError(
				`OWLAT_PORT_OFFSET=${offset} would put port ${MAX_BASE_PORT + offset} above ${MAX_PORT}; use 0 to ${MAX_EXPLICIT_OFFSET}.`
			);
		}
		return { offset, source: `OWLAT_PORT_OFFSET=${offset}` };
	}
	if (!input.linkedWorktree) {
		return { offset: 0, source: 'main checkout (default ports)' };
	}
	const slot = Number.parseInt(rootHash(input.root).slice(0, 8), 16) % OFFSET_SLOTS;
	return {
		offset: OFFSET_MIN + OFFSET_STRIDE * slot,
		source: `hash of the worktree path (slot ${slot})`,
	};
}

export function portsFor(offset: number): DevPorts {
	const ports = {} as DevPorts;
	for (const [service, base] of Object.entries(BASE_PORTS) as Array<[DevService, number]>) {
		ports[service] = base + offset;
	}
	return ports;
}

/**
 * Compose project names allow lowercase letters, digits, `-` and `_`. The
 * name carries the checkout's basename for humans and a path hash so two
 * checkouts with the same basename stay apart; the project scopes the
 * containers, the network and the named volumes.
 */
export function composeProjectName(root: string): string {
	const slug = basename(root)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 24)
		.replace(/-+$/, '');
	return `owlat-dev-${slug ? `${slug}-` : ''}${rootHash(root).slice(0, 8)}`;
}

export interface DevStackConfig {
	readonly root: string;
	readonly project: string;
	readonly offset: number;
	readonly offsetSource: string;
	readonly ports: DevPorts;
	/** Browser-facing URLs. The SPA, CSP and auth origins all derive from these. */
	readonly urls: {
		readonly web: string;
		readonly convex: string;
		readonly convexSite: string;
	};
}

export function resolveDevStackConfig(input: OffsetInput): DevStackConfig {
	const { offset, source } = resolvePortOffset(input);
	const ports = portsFor(offset);
	return {
		root: input.root,
		project: composeProjectName(input.root),
		offset,
		offsetSource: source,
		ports,
		urls: {
			// `localhost`, not 127.0.0.1: it is the origin `nuxt dev` prints and
			// the one BetterAuth must trust, so the browser and SITE_URL agree.
			web: `http://localhost:${ports.web}`,
			convex: `http://127.0.0.1:${ports.convex}`,
			convexSite: `http://127.0.0.1:${ports.convexSite}`,
		},
	};
}

/**
 * Variables the Nuxt dev server needs to talk to this stack. Passed as process
 * env, which wins over the repository `.env` files `apps/web`'s dev script
 * loads, so a `.env` pointing at a hosted deployment does not leak in.
 */
export function webEnv(config: DevStackConfig): Record<string, string> {
	return {
		PORT: String(config.ports.web),
		NUXT_PORT: String(config.ports.web),
		NUXT_PUBLIC_SITE_URL: config.urls.web,
		NUXT_PUBLIC_CONVEX_URL: config.urls.convex,
		NUXT_PUBLIC_CONVEX_SITE_URL: config.urls.convexSite,
	};
}

/**
 * Deployment variables that must follow the derived ports. Everything else on
 * the deployment (provider keys a developer set by hand) is left alone.
 * `CONVEX_SITE_URL` is not among them: the backend provides it from the
 * container's CONVEX_SITE_ORIGIN and the CLI refuses to set it.
 */
export function deploymentUrlEnv(config: DevStackConfig): Record<string, string> {
	return {
		SITE_URL: config.urls.web,
		ALLOWED_ORIGINS: config.urls.web,
	};
}

/** Human-readable port table printed at startup and by `dev:stack ports`. */
export function describePorts(config: DevStackConfig): string {
	const { ports, urls } = config;
	return [
		`Compose project  ${config.project}`,
		`Port offset      ${config.offset} (${config.offsetSource})`,
		`Web              ${urls.web}`,
		`Convex           ${urls.convex}`,
		`Convex site      ${urls.convexSite}`,
		`Redis            redis://127.0.0.1:${ports.redis}`,
		`MTA (by hand)    PORT=${ports.mta}`,
		`Mail sync (hand) MAIL_SYNC_PORT=${ports.mailSync}`,
	].join('\n');
}
