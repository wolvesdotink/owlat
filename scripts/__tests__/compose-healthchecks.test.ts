/**
 * Every long-running service in a shipped compose template declares a
 * healthcheck, so `docker compose ps`, `owlat doctor` and the updater's
 * post-rollout readiness wait can tell a serving container from one that is
 * merely running. A container whose process is up but whose listener never
 * bound used to count as ready.
 *
 * Pinned off the real templates: a new long-running service fails here until
 * it declares a probe (or is listed as a one-shot), and the release compose
 * the updater downloads keeps every probe the checked-in file declares.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const TEMPLATES = ['docker-compose.yml', 'infra/templates/docker-compose.vps.yml'] as const;

/** Services that run to completion; a healthcheck would never be consulted. */
const ONE_SHOTS = new Set(['convex-deploy', 'imap-cert-init', 'ollama-models']);

/** Services whose image declares the healthcheck; compose must not override it. */
const IMAGE_HEALTHCHECKS: Record<string, string> = {
	'decision-local': 'apps/decision-local/Dockerfile',
};

/**
 * The updater's readiness wait stretches for a declared start period only up
 * to twelve minutes (apps/updater/src/readiness.ts); a longer grace would be
 * reported as still starting on every rollout that recreates the service.
 */
const MAX_START_PERIOD_S = 720;

/** The listen-port variable each HTTP or TCP probe must agree with. */
const PROBED_PORTS: Record<string, string> = {
	web: 'PORT',
	mta: 'PORT',
	updater: 'PORT',
	'mail-sync': 'MAIL_SYNC_PORT',
	imap: 'IMAP_PORT',
};

/** Dependencies that must be healthy, not just started. */
const HEALTHY_EDGES: Array<[string, string]> = [
	['updater', 'docker-socket-proxy'],
	['code-worker', 'convex-fn-proxy'],
	['code-worker', 'code-worker-egress'],
];

/** Fail-open dependencies: the MTA must never wait on these. */
const FAIL_OPEN_EDGES: Array<[string, string]> = [
	['mta', 'clamav'],
	['mta', 'dns-resolver'],
];

interface Healthcheck {
	test?: string | string[];
	interval?: string;
	timeout?: string;
	retries?: number;
	start_period?: string;
	disable?: boolean;
}

interface Dependency {
	condition?: string;
	required?: boolean;
}

interface Service {
	restart?: string;
	healthcheck?: Healthcheck;
	environment?: Record<string, string | number>;
	depends_on?: string[] | Record<string, Dependency>;
}

type Services = Record<string, Service>;

function services(source: string): Services {
	return (parse(source) as { services: Services }).services;
}

function readServices(file: string): Services {
	return services(readFileSync(join(REPOSITORY_ROOT, file), 'utf8'));
}

function seconds(duration: string | undefined): number {
	const match = /^(\d+)(s|m)$/.exec(duration ?? '');
	if (!match) throw new Error(`unexpected duration ${JSON.stringify(duration)}`);
	return Number(match[1]) * (match[2] === 'm' ? 60 : 1);
}

function dependencies(service: Service): Record<string, Dependency> {
	const declared = service.depends_on ?? {};
	if (Array.isArray(declared)) {
		return Object.fromEntries(declared.map((name) => [name, { condition: 'service_started' }]));
	}
	return declared;
}

/** The shell command of a CMD-SHELL probe, with compose's `$$` escapes undone. */
function shellProbe(check: Healthcheck | undefined): string {
	const test = check?.test;
	if (!Array.isArray(test) || test[0] !== 'CMD-SHELL' || typeof test[1] !== 'string') {
		throw new Error('expected a CMD-SHELL probe');
	}
	return test[1].replaceAll('$$', '$');
}

/** Seconds the probe's own client waits before giving up, if it says. */
function clientTimeout(test: string[]): number | undefined {
	for (const flag of ['-T', '--max-time', '-w']) {
		const at = test.indexOf(flag);
		if (at !== -1) return Number(test[at + 1]);
	}
	const signal = /AbortSignal\.timeout\((\d+)\)/.exec(test.join(' '));
	return signal ? Number(signal[1]) / 1000 : undefined;
}

describe.each(TEMPLATES)('%s', (file) => {
	const all = readServices(file);
	const longRunning = Object.keys(all).filter((name) => !ONE_SHOTS.has(name));

	it.each(longRunning.filter((name) => !(name in IMAGE_HEALTHCHECKS)))(
		'%s declares a bounded healthcheck',
		(name) => {
			const check = all[name]?.healthcheck;
			expect(check, `${name} has no healthcheck`).toBeDefined();
			expect(check?.disable).not.toBe(true);
			expect(Array.isArray(check?.test)).toBe(true);
			const test = check?.test as string[];
			expect(['CMD', 'CMD-SHELL']).toContain(test[0]);
			expect(seconds(check?.interval)).toBeGreaterThan(0);
			expect(check?.retries).toBeGreaterThan(0);
			expect(seconds(check?.start_period ?? '0s')).toBeLessThanOrEqual(MAX_START_PERIOD_S);
			const timeout = seconds(check?.timeout);
			expect(timeout).toBeLessThan(seconds(check?.interval));
			const client = clientTimeout(test);
			if (client !== undefined) expect(client).toBeLessThan(timeout);
		}
	);

	it.each(Object.keys(all).filter((name) => ONE_SHOTS.has(name)))(
		'%s is a one-shot, not a restarting service',
		(name) => {
			expect(all[name]?.restart ?? 'no').toBe('no');
		}
	);

	it.each(Object.entries(PROBED_PORTS).filter(([name]) => name in all))(
		'%s is probed on the port it listens on',
		(name, variable) => {
			const port = String(all[name]?.environment?.[variable]);
			const test = [all[name]?.healthcheck?.test ?? []].flat().join(' ');
			expect(test).toMatch(new RegExp(`127\\.0\\.0\\.1[: ]${port}\\b`));
		}
	);

	it.each(HEALTHY_EDGES.filter(([from]) => from in all))(
		'%s waits for %s to be healthy',
		(from, to) => {
			expect(dependencies(all[from]!)[to]?.condition).toBe('service_healthy');
		}
	);

	it.each(FAIL_OPEN_EDGES.filter(([from]) => from in all))(
		'%s still starts without waiting on %s',
		(from, to) => {
			expect(dependencies(all[from]!)[to]).toEqual({
				condition: 'service_started',
				required: false,
			});
		}
	);

	it('waits only on dependencies that can become healthy', () => {
		for (const [name, service] of Object.entries(all)) {
			for (const [target, edge] of Object.entries(dependencies(service))) {
				if (edge.condition !== 'service_healthy') continue;
				const declared = all[target]?.healthcheck !== undefined || target in IMAGE_HEALTHCHECKS;
				expect(declared, `${name} waits on ${target}, which has no healthcheck`).toBe(true);
			}
		}
	});

	it('has no dependency cycle', () => {
		const visiting = new Set<string>();
		const done = new Set<string>();
		const visit = (name: string, path: string[]) => {
			if (done.has(name)) return;
			expect(visiting.has(name), `cycle: ${[...path, name].join(' -> ')}`).toBe(false);
			visiting.add(name);
			for (const target of Object.keys(dependencies(all[name] ?? {}))) {
				visit(target, [...path, name]);
			}
			visiting.delete(name);
			done.add(name);
		};
		for (const name of Object.keys(all)) visit(name, []);
	});

	it.each(Object.keys(IMAGE_HEALTHCHECKS).filter((name) => name in all))(
		'%s keeps the healthcheck its image declares',
		(name) => {
			expect(all[name]?.healthcheck).toBeUndefined();
			const dockerfile = readFileSync(join(REPOSITORY_ROOT, IMAGE_HEALTHCHECKS[name]!), 'utf8');
			expect(dockerfile).toMatch(/^HEALTHCHECK /m);
		}
	);
});

describe('the exemption lists', () => {
	it('name only services a template still has', () => {
		const names = new Set(TEMPLATES.flatMap((file) => Object.keys(readServices(file))));
		for (const name of [...ONE_SHOTS, ...Object.keys(IMAGE_HEALTHCHECKS)]) {
			expect(names.has(name), `${name} is in no template`).toBe(true);
		}
	});
});

describe('the release compose', () => {
	const roots: string[] = [];
	afterEach(() => {
		while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
	});

	it('keeps every healthcheck and dependency condition of docker-compose.yml', () => {
		const root = mkdtempSync(join(tmpdir(), 'owlat-release-healthchecks-'));
		roots.push(root);
		const source = readFileSync(join(REPOSITORY_ROOT, 'docker-compose.yml'), 'utf8');
		writeFileSync(join(root, 'docker-compose.yml'), source);
		execFileSync('bash', [join(REPOSITORY_ROOT, 'scripts/gen-release-compose.sh'), '9.9.9'], {
			cwd: root,
		});

		const release = services(readFileSync(join(root, 'docker-compose-9.9.9.yml'), 'utf8'));
		const checkedIn = services(source);
		for (const [name, service] of Object.entries(checkedIn)) {
			expect(release[name]?.healthcheck, name).toEqual(service.healthcheck);
			expect(release[name]?.depends_on, name).toEqual(service.depends_on);
		}
	});
});

describe('the code-worker heartbeat probe', () => {
	const dirs: string[] = [];
	afterEach(() => {
		while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
	});

	function check(ageSeconds: number | null): number | null {
		const probe = shellProbe(readServices('docker-compose.yml')['code-worker']?.healthcheck);
		const dir = mkdtempSync(join(tmpdir(), 'owlat-heartbeat-probe-'));
		dirs.push(dir);
		const file = join(dir, 'heartbeat');
		if (ageSeconds !== null) {
			writeFileSync(file, 'beat\n');
			const at = Date.now() / 1000 - ageSeconds;
			utimesSync(file, at, at);
		}
		const command = probe.replaceAll('/tmp/owlat-code-worker.heartbeat', file);
		expect(command).not.toBe(probe);
		return spawnSync('sh', ['-c', command]).status;
	}

	it('passes on a recent heartbeat', () => {
		expect(check(0)).toBe(0);
	});

	it('fails on a stale or missing one', () => {
		expect(check(180)).not.toBe(0);
		expect(check(null)).not.toBe(0);
	});
});
