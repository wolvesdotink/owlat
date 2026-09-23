/**
 * What "the release is up" has to mean before the updater says so.
 *
 * `docker compose up -d` returns once it has created and started containers.
 * It does not wait for a healthcheck to pass, and a container that crashes a
 * second after starting has still "started". The rollout used to answer
 * `success: true` at that point, and the recovery path called any service in
 * state `running` serving, including one failing its healthcheck.
 *
 * The readiness contract, for every service the rollout started (the active
 * profiles' services, minus the updater and the socket proxy):
 *
 *   - a service with a healthcheck (convex, redis, clamav) is `healthy`;
 *   - a service without one is `running`, not `restarting`;
 *   - a one-shot service (`restart: "no"`, e.g. imap-cert-init) has exited 0;
 *   - all of the above still hold one settle interval later, so a container
 *     that dies right after starting is not counted as up;
 *   - and when `web` is part of the rollout, it answers an HTTP request.
 *
 * The wait is bounded. A service still starting when the bound runs out is
 * reported as such rather than as healthy or as failed.
 */
import { parseComposePs, type ComposeService } from '@owlat/shared/containerHealth';
import { exec, OWLAT_DIR } from './http.js';

/** Where a service stands against the contract above. */
type Standing = 'ready' | 'starting' | 'missing' | 'failing';

interface ServiceVerdict {
	service: string;
	standing: Standing;
	detail: string;
}

interface SmokeResult {
	ok: boolean;
	detail: string;
}

export interface ReadinessProbe {
	/** Every container of the project, or null when Docker would not say. */
	list(): ComposeService[] | null;
	/** An HTTP request against the stack; null when there is nothing to ask. */
	smoke(): Promise<SmokeResult | null>;
}

export interface ReadinessTiming {
	timeoutMs: number;
	firstPollMs: number;
	maxPollMs: number;
	settleMs: number;
	now(): number;
	sleep(ms: number): Promise<void>;
}

interface ReadinessResult {
	ready: boolean;
	/** One line for the step report. */
	summary: string;
}

/**
 * Three minutes covers convex (healthy within ~25 s: 10 s start period, 15 s
 * interval) and redis (10 s interval) with room to spare, and a ClamAV that
 * reuses its signature volume. A ClamAV downloading its signatures from
 * scratch can take longer; it is then reported as still starting.
 */
const DEFAULT_TIMING: ReadinessTiming = {
	timeoutMs: 180_000,
	firstPollMs: 2_000,
	maxPollMs: 10_000,
	settleMs: 5_000,
	now: () => Date.now(),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

let timing: ReadinessTiming = DEFAULT_TIMING;

/**
 * Shorten the wait. The updater's endpoint tests drive a real HTTP server, so
 * they cannot hand the handler a timing of their own.
 */
export function setReadinessTiming(overrides: Partial<ReadinessTiming> | null): void {
	timing = overrides ? { ...DEFAULT_TIMING, ...overrides } : DEFAULT_TIMING;
}

/**
 * The web app as the other containers reach it (the compose service name and
 * its PORT, the same address Caddy proxies to). `/api/instance-info` is public,
 * reads only runtime config, and answers as soon as Nitro serves requests.
 */
const WEB_SMOKE_URL = 'http://web:3000/api/instance-info';
const SMOKE_TIMEOUT_MS = 5_000;

const RANK: Record<Standing, number> = { ready: 0, starting: 1, missing: 2, failing: 3 };

function judgeContainer(row: ComposeService): { standing: Standing; detail: string } {
	if (row.state === 'running') {
		if (row.health === 'unhealthy')
			return { standing: 'failing', detail: 'failing its healthcheck' };
		if (row.health === 'starting') {
			return { standing: 'starting', detail: 'healthcheck has not passed yet' };
		}
		return { standing: 'ready', detail: row.health === 'healthy' ? 'healthy' : 'running' };
	}
	if (row.state === 'exited' && /^exited \(0\)/i.test(row.status)) {
		return { standing: 'ready', detail: 'completed' };
	}
	if (row.state === 'created') return { standing: 'starting', detail: 'created, not started' };
	if (row.state === 'restarting')
		return { standing: 'failing', detail: 'restarting after a crash' };
	return { standing: 'failing', detail: row.status || row.state || 'not running' };
}

/**
 * One service's standing. When any of its containers is running, only the
 * running ones are judged: a recreate that was cut short can leave the old,
 * stopped container behind next to the new one.
 */
function judgeService(service: string, rows: ComposeService[]): ServiceVerdict {
	const mine = rows.filter((row) => row.service === service);
	if (mine.length === 0) return { service, standing: 'missing', detail: 'no container' };
	const running = mine.filter((row) => row.state === 'running');
	const judged = (running.length > 0 ? running : mine).map(judgeContainer);
	const worst = judged.reduce((a, b) => (RANK[b.standing] > RANK[a.standing] ? b : a));
	return { service, ...worst };
}

function problems(verdicts: ServiceVerdict[]): string {
	const groups: Array<[Standing, string]> = [
		['failing', 'not healthy'],
		['missing', 'not started'],
		['starting', 'still starting'],
	];
	return groups
		.map(([standing, label]) => {
			const hit = verdicts.filter((v) => v.standing === standing);
			return hit.length > 0
				? `${label}: ${hit.map((v) => `${v.service} (${v.detail})`).join(', ')}`
				: '';
		})
		.filter(Boolean)
		.join('; ');
}

/**
 * Poll until every service meets the contract, or the bound runs out.
 *
 * Backs off from `firstPollMs` to `maxPollMs`. Nothing short-circuits to a
 * failure: services are started together, so one that crashes because a
 * dependency was not up yet gets restarted and may still come good in time.
 */
export async function waitForReadiness(
	services: string[],
	probe: ReadinessProbe,
	clock: ReadinessTiming = timing
): Promise<ReadinessResult> {
	const started = clock.now();
	const deadline = started + clock.timeoutMs;
	let delay = clock.firstPollMs;
	let settled = false;
	let lastProblem = 'not checked';

	for (;;) {
		const rows = probe.list();
		if (rows === null) {
			settled = false;
			lastProblem =
				'the container list could not be read back, so the state of the stack is unknown';
		} else {
			const verdicts = services.map((service) => judgeService(service, rows));
			const problem = problems(verdicts);
			if (problem) {
				settled = false;
				lastProblem = problem;
			} else if (!settled) {
				// Every service looks up. Look again one settle interval later
				// before believing it.
				settled = true;
				lastProblem = 'every service was up once, but not yet confirmed';
			} else {
				const smoke = await probe.smoke();
				if (!smoke || smoke.ok) {
					const smokeNote = smoke ? `; ${smoke.detail}` : '';
					return {
						ready: true,
						summary: `All ${services.length} services are up and stayed up (${verdictsLine(verdicts)})${smokeNote}.`,
					};
				}
				lastProblem = smoke.detail;
			}
		}

		const wait = settled ? clock.settleMs : delay;
		if (clock.now() + wait > deadline) break;
		await clock.sleep(wait);
		if (!settled) delay = Math.min(delay * 2, clock.maxPollMs);
	}

	const seconds = Math.round((clock.now() - started) / 1000);
	return { ready: false, summary: `Not ready after ${seconds}s: ${lastProblem}.` };
}

function verdictsLine(verdicts: ServiceVerdict[]): string {
	return verdicts.map((v) => `${v.service}: ${v.detail}`).join(', ');
}

async function smokeWeb(): Promise<SmokeResult> {
	try {
		const response = await fetch(WEB_SMOKE_URL, { signal: AbortSignal.timeout(SMOKE_TIMEOUT_MS) });
		// Drain the body so the connection is released.
		await response.arrayBuffer();
		return response.ok
			? { ok: true, detail: `web answered HTTP ${response.status}` }
			: { ok: false, detail: `web answered HTTP ${response.status} to ${WEB_SMOKE_URL}` };
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return { ok: false, detail: `web did not answer ${WEB_SMOKE_URL}: ${reason}` };
	}
}

/**
 * The real probe: `docker compose ps --all` through the same
 * project-directory-aware invocation as the rollout (`--all`, so a one-shot
 * service that finished is seen as finished rather than missing), and a
 * request to the web app when the rollout started it.
 */
function stackProbe(services: string[], composeArgs: string[]): ReadinessProbe {
	return {
		list() {
			const listed = exec('docker', [...composeArgs, 'ps', '--all', '--format', 'json'], OWLAT_DIR);
			if (!listed.ok || !listed.stdout.trim()) return null;
			return parseComposePs(listed.stdout);
		},
		smoke: () => (services.includes('web') ? smokeWeb() : Promise.resolve(null)),
	};
}

/** Wait for `services` to meet the readiness contract. Never throws. */
export async function verifyReadiness(
	services: string[],
	composeArgs: string[]
): Promise<ReadinessResult> {
	try {
		return await waitForReadiness(services, stackProbe(services, composeArgs));
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return { ready: false, summary: `Readiness could not be checked: ${reason}.` };
	}
}
