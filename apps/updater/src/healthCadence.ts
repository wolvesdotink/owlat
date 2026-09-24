/**
 * The healthcheck cadence each service declares in the compose file.
 *
 * Docker only re-evaluates a container's health once per `interval`, and it
 * ignores failing checks for the first `start_period`. A readiness wait that
 * ignores both calls a slow-but-healthy service failed: ClamAV declares
 * `interval: 60s, start_period: 600s`, so a clamd that finishes loading its
 * signatures at 125 s is only reported `healthy` at the 180 s probe, and one
 * downloading them from scratch may legitimately take most of ten minutes.
 *
 * Read from `docker compose config --format json`, which prints each duration
 * the way Go formats one (`"1m0s"`, `"10m0s"`, `"500ms"`).
 */

export interface HealthCadence {
	intervalMs: number;
	startPeriodMs: number;
}

/** Docker's own default when a healthcheck sets no interval. */
const DOCKER_DEFAULT_INTERVAL_MS = 30_000;

const UNIT_MS: Record<string, number> = {
	h: 3_600_000,
	m: 60_000,
	s: 1_000,
	ms: 1,
	us: 0.001,
	µs: 0.001,
	ns: 0.000_001,
};

/** A Go duration string (`1m0s`, `1h2m`, `500ms`) in milliseconds, or null. */
export function parseGoDuration(value: unknown): number | null {
	if (typeof value !== 'string') return null;
	const text = value.trim();
	if (!text) return null;
	// Sticky, so the parts have to cover the whole string with nothing between
	// them; `ms` is tried before `m` so `500ms` is not read as 500 minutes.
	const part = /(\d+(?:\.\d+)?)(ms|us|µs|ns|h|m|s)/y;
	let total = 0;
	let consumed = 0;
	for (let match = part.exec(text); match; match = part.exec(text)) {
		total += Number.parseFloat(match[1] ?? '0') * (UNIT_MS[match[2] ?? ''] ?? 0);
		consumed = part.lastIndex;
	}
	return consumed === text.length ? total : null;
}

/**
 * Every service with an active healthcheck, keyed by service name. Output
 * that does not parse yields an empty map, which leaves the readiness wait at
 * its fixed bound: the cadence can only lengthen the wait, never break it.
 */
export function parseHealthCadence(configJson: string): Map<string, HealthCadence> {
	const cadence = new Map<string, HealthCadence>();
	let doc: unknown;
	try {
		doc = JSON.parse(configJson);
	} catch {
		return cadence;
	}
	const services = (doc as { services?: unknown } | null)?.services;
	if (typeof services !== 'object' || services === null) return cadence;

	for (const [name, service] of Object.entries(services)) {
		const check = (service as { healthcheck?: unknown } | null)?.healthcheck;
		if (typeof check !== 'object' || check === null) continue;
		const declared = check as Record<string, unknown>;
		if (declared['disable'] === true) continue;
		const test = declared['test'];
		if (Array.isArray(test) && test[0] === 'NONE') continue;
		cadence.set(name, {
			intervalMs: parseGoDuration(declared['interval']) ?? DOCKER_DEFAULT_INTERVAL_MS,
			startPeriodMs: parseGoDuration(declared['start_period']) ?? 0,
		});
	}
	return cadence;
}
