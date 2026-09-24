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
 * The wait is bounded, and each service's bound follows the healthcheck
 * cadence it declares (healthCadence.ts): Docker probes once per `interval`
 * and forgives failures for the first `start_period`, so a service is given
 * until the probe after both the base bound and its start period have passed,
 * up to a hard maximum. A service still starting when the bound runs out is
 * reported as such rather than as healthy or as failed, and one still inside
 * its start period as warming up.
 *
 * A service that was already failing before the rollout touched it is not the
 * rollout's doing: it is reported as a warning and does not hold the verdict.
 */
import { parseComposePs, type ComposeService } from '@owlat/shared/containerHealth';
import { exec, OWLAT_DIR } from './http.js';
import { parseHealthCadence, type HealthCadence } from './healthCadence.js';

/** Where a service stands against the contract above. */
type Standing = 'ready' | 'warming' | 'starting' | 'missing' | 'failing';

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
	/** The healthcheck cadence each service declares; none when unknown. */
	cadence?(): Map<string, HealthCadence>;
}

export interface ReadinessTiming {
	/** What every service gets, whatever it declares. */
	timeoutMs: number;
	/** How far a declared healthcheck cadence may stretch the wait. */
	maxTimeoutMs?: number;
	firstPollMs: number;
	maxPollMs: number;
	settleMs: number;
	now(): number;
	sleep(ms: number): Promise<void>;
}

export interface ReadinessResult {
	ready: boolean;
	/** One line for the step report. */
	summary: string;
	/** Services that were already failing before the rollout, still failing. */
	warnings: string[];
}

/**
 * Three minutes covers convex (healthy within ~25 s: 10 s start period, 15 s
 * interval) and redis (10 s interval) with room to spare. ClamAV declares a
 * 600 s start period and a 60 s interval, so a rollout that recreates it may
 * wait up to 665 s; twelve minutes is the most any declared cadence gets.
 */
const DEFAULT_TIMING: ReadinessTiming = {
	timeoutMs: 180_000,
	maxTimeoutMs: 720_000,
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

/**
 * The recovery after a failed `up` answers a request that is already
 * reporting a failure: web's /apply-profiles route gives the whole exchange
 * ten minutes, a cold image pull and the failed `up` included, and the
 * host-side remediation in the answer is lost if the wait outlasts it. So
 * recovery checks briefly and never stretches for a declared cadence; a slow
 * service is then reported as warming up.
 */
const RECOVERY_BOUND = { timeoutMs: 60_000, maxTimeoutMs: 60_000 };

const RANK: Record<Standing, number> = {
	ready: 0,
	warming: 1,
	starting: 1,
	missing: 2,
	failing: 3,
};

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

/**
 * A service still starting inside the start period it declares is not failing:
 * Docker itself forgives its failing checks until then.
 */
function warmingUp(
	verdict: ServiceVerdict,
	cadence: Map<string, HealthCadence>,
	elapsedMs: number
): ServiceVerdict {
	const declared = cadence.get(verdict.service);
	if (verdict.standing !== 'starting' || !declared || elapsedMs >= declared.startPeriodMs) {
		return verdict;
	}
	const seconds = Math.round(declared.startPeriodMs / 1000);
	return {
		...verdict,
		standing: 'warming',
		detail: `${verdict.detail}, within its ${seconds}s start period`,
	};
}

/**
 * How long `service` may take, from the moment `up` returned. With a declared
 * healthcheck: until Docker's next probe after both the base bound and the
 * start period have passed, plus one settle interval to confirm it, capped.
 */
function allowanceMs(
	service: string,
	cadence: Map<string, HealthCadence>,
	clock: ReadinessTiming
): number {
	const declared = cadence.get(service);
	if (!declared) return clock.timeoutMs;
	const wanted =
		Math.max(clock.timeoutMs, declared.startPeriodMs) + declared.intervalMs + clock.settleMs;
	const cap = Math.max(clock.timeoutMs, clock.maxTimeoutMs ?? clock.timeoutMs);
	return Math.min(wanted, cap);
}

function problems(verdicts: ServiceVerdict[]): string {
	const groups: Array<[Standing, string]> = [
		['failing', 'not healthy'],
		['missing', 'not started'],
		['starting', 'still starting'],
		['warming', 'still warming up'],
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

/** Options that come from the rollout rather than from the stack. */
export interface ReadinessContext {
	/** Services already failing before the rollout, with what was wrong then. */
	preExisting?: ReadonlyMap<string, string>;
}

/**
 * Poll until every service meets the contract, or the bound runs out.
 *
 * Backs off from `firstPollMs` to `maxPollMs`. Nothing short-circuits to a
 * failure: services are started together, so one that crashes because a
 * dependency was not up yet gets restarted and may still come good in time.
 *
 * The bound starts at `timeoutMs` and grows to the allowance of any service
 * that is still not ready (see `allowanceMs`). Services in `preExisting` never
 * hold the verdict or stretch the wait; if they are still not ready at the
 * end, they come back as warnings.
 */
export async function waitForReadiness(
	services: string[],
	probe: ReadinessProbe,
	clock: ReadinessTiming = timing,
	context: ReadinessContext = {}
): Promise<ReadinessResult> {
	const preExisting = context.preExisting ?? new Map<string, string>();
	const cadence = probe.cadence?.() ?? new Map<string, HealthCadence>();
	const started = clock.now();
	let deadline = started + clock.timeoutMs;
	let delay = clock.firstPollMs;
	let settled = false;
	let lastProblem = 'not checked';
	let lastVerdicts: ServiceVerdict[] = [];
	let webLingers: string | null = null;

	for (;;) {
		const rows = probe.list();
		if (rows === null) {
			settled = false;
			lastProblem =
				'the container list could not be read back, so the state of the stack is unknown';
		} else {
			const elapsed = clock.now() - started;
			const verdicts = services.map((service) =>
				warmingUp(judgeService(service, rows), cadence, elapsed)
			);
			lastVerdicts = verdicts;
			const blocking = verdicts.filter(
				(v) => v.standing !== 'ready' && !preExisting.has(v.service)
			);
			for (const v of blocking) {
				deadline = Math.max(deadline, started + allowanceMs(v.service, cadence, clock));
			}
			const problem = problems(blocking);
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
				// A web app that was already failing before the update is not
				// the update's doing either.
				webLingers = smoke && !smoke.ok && preExisting.has('web') ? smoke.detail : null;
				if (!smoke || smoke.ok || webLingers) {
					const smokeNote = smoke?.ok ? `; ${smoke.detail}` : '';
					const warnings = lingering(verdicts, preExisting, webLingers);
					const ready = verdicts.filter((v) => v.standing === 'ready');
					const upLine =
						ready.length === services.length
							? `All ${services.length} services are up and stayed up`
							: `${ready.length} of ${services.length} services are up and stayed up`;
					return {
						ready: true,
						summary: `${upLine} (${verdictsLine(ready)})${smokeNote}.${warningNote(warnings)}`,
						warnings,
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
	const warnings = lingering(lastVerdicts, preExisting, webLingers);
	return {
		ready: false,
		summary: `Not ready after ${seconds}s: ${lastProblem}.${warningNote(warnings)}`,
		warnings,
	};
}

/** Pre-existing failures that the rollout did not fix. */
function lingering(
	verdicts: ServiceVerdict[],
	preExisting: ReadonlyMap<string, string>,
	webSmoke: string | null
): string[] {
	const warnings = verdicts
		.filter((v) => v.standing !== 'ready' && preExisting.has(v.service))
		.map(
			(v) =>
				`${v.service} was already ${preExisting.get(v.service)} before the update and is still ${v.detail}`
		);
	if (webSmoke && !warnings.some((w) => w.startsWith('web '))) {
		warnings.push(`web was already ${preExisting.get('web')} before the update; ${webSmoke}`);
	}
	return warnings;
}

function warningNote(warnings: string[]): string {
	return warnings.length > 0 ? ` Already failing before the update: ${warnings.join('; ')}.` : '';
}

function verdictsLine(verdicts: ServiceVerdict[]): string {
	return verdicts.map((v) => `${v.service}: ${v.detail}`).join(', ');
}

async function smokeWeb(): Promise<SmokeResult> {
	try {
		// nosemgrep -- plain HTTP to the web container's compose-internal hostname; this request never leaves the Docker network, which has no TLS terminator.
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
 * service that finished is seen as finished rather than missing), a request
 * to the web app when the rollout started it, and the healthcheck cadence the
 * compose file declares.
 */
function stackProbe(services: string[], composeArgs: string[]): ReadinessProbe {
	return {
		list() {
			const listed = exec('docker', [...composeArgs, 'ps', '--all', '--format', 'json'], OWLAT_DIR);
			if (!listed.ok || !listed.stdout.trim()) return null;
			return parseComposePs(listed.stdout);
		},
		smoke: () => (services.includes('web') ? smokeWeb() : Promise.resolve(null)),
		cadence() {
			const config = exec('docker', [...composeArgs, 'config', '--format', 'json'], OWLAT_DIR);
			return config.ok ? parseHealthCadence(config.stdout) : new Map();
		},
	};
}

/**
 * The services that are failing right now, before a rollout touches them, with
 * what is wrong. An unreadable container list yields none: the rollout is then
 * judged on its own, as it would have been without this.
 */
export function failingBeforeRollout(
	services: string[],
	composeArgs: string[]
): Map<string, string> {
	const failing = new Map<string, string>();
	try {
		const rows = stackProbe(services, composeArgs).list();
		if (!rows) return failing;
		for (const service of services) {
			const verdict = judgeService(service, rows);
			if (verdict.standing === 'failing') failing.set(service, verdict.detail);
		}
	} catch {
		// Best-effort context for the verdict; never a reason to stop.
	}
	return failing;
}

interface VerifyOptions extends ReadinessContext {
	/** The short, cadence-blind bound used after a failed `up` (see RECOVERY_BOUND). */
	recovery?: boolean;
}

/** Wait for `services` to meet the readiness contract. Never throws. */
export async function verifyReadiness(
	services: string[],
	composeArgs: string[],
	options: VerifyOptions = {}
): Promise<ReadinessResult> {
	const clock = options.recovery
		? {
				...timing,
				timeoutMs: Math.min(timing.timeoutMs, RECOVERY_BOUND.timeoutMs),
				maxTimeoutMs: Math.min(
					timing.maxTimeoutMs ?? timing.timeoutMs,
					RECOVERY_BOUND.maxTimeoutMs
				),
			}
		: timing;
	try {
		return await waitForReadiness(services, stackProbe(services, composeArgs), clock, options);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return { ready: false, summary: `Readiness could not be checked: ${reason}.`, warnings: [] };
	}
}
