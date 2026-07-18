/**
 * Tier-3 seed-list placement analyzer — the WORKER (host-controlled) half of the
 * Deliverability Lab's sandboxed job.
 *
 * This runs inside the PP-27 sandbox: dropped to the unprivileged uid, with no
 * ambient credentials, under a wall-clock budget. It is therefore deliberately
 * SELF-CONTAINED — it imports nothing from the example plugin package (host code
 * must never load third-party plugin code) and nothing with side effects. It
 * takes the plugin's UNTRUSTED job payload, fans the message across the seed
 * list, and reports a deterministic per-seed placement (inbox / promotions /
 * spam). Determinism (a pure hash of address+subject, biased by a compact spam
 * signal — no clock, no RNG, no network) is what makes the job reproducible and
 * its tests non-flaky.
 *
 * The payload/result shapes are the SAME wire contract the plugin's
 * `buildSeedTestPayload` / `parseSeedTestResult` own; a shared fixture
 * (`fixtures/deliverability-lab/seed-test-payload.json`) pins the two sides.
 */

/** Upper bound on seeds a single job will process; mirrors the plugin's own cap. */
export const SEED_TEST_MAX_SEEDS = 50;

export type SeedFolder = 'inbox' | 'promotions' | 'spam';

export interface SeedPlacement {
	readonly address: string;
	readonly folder: SeedFolder;
}

export interface SeedTestResult {
	readonly seeds: number;
	readonly inbox: number;
	readonly promotions: number;
	readonly spam: number;
	readonly placementRate: number;
	readonly placements: readonly SeedPlacement[];
}

/** Raised on a payload that is missing or structurally invalid; the job fails closed. */
export class SeedTestInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SeedTestInputError';
	}
}

const TRIGGER_PHRASES: readonly string[] = [
	'act now',
	'buy now',
	'click here',
	'congratulations',
	'free money',
	'guaranteed',
	'limited time',
	'risk free',
	'winner',
	'100% free',
];

/** FNV-1a 32-bit hash → a stable value in [0,100). No dependency, no allocation churn. */
function bucketOf(value: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0) % 100;
}

function spamSignal(subject: string, body: string): number {
	const haystack = `${subject}\n${body}`.toLowerCase();
	let hits = TRIGGER_PHRASES.reduce((count, phrase) => count + (haystack.includes(phrase) ? 1 : 0), 0);
	const letters = subject.replace(/[^A-Za-z]/g, '');
	if (letters.length >= 4 && letters === letters.toUpperCase()) hits += 2;
	return hits;
}

function readString(object: Record<string, unknown>, key: string): string {
	const value = object[key];
	return typeof value === 'string' ? value : '';
}

/**
 * Analyze a seed-test payload and return the completed result as a JSON string.
 * Throws {@link SeedTestInputError} on malformed input so the worker fails the
 * job closed instead of emitting a bogus "all inbox" result.
 */
export function runSeedTest(payloadJson: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(payloadJson);
	} catch {
		throw new SeedTestInputError('Payload is not valid JSON.');
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new SeedTestInputError('Payload must be a JSON object.');
	}
	const object = parsed as Record<string, unknown>;

	const rawSeeds = object['seeds'];
	if (!Array.isArray(rawSeeds) || rawSeeds.length === 0) {
		throw new SeedTestInputError('Payload must include a non-empty seeds array.');
	}
	if (rawSeeds.length > SEED_TEST_MAX_SEEDS) {
		throw new SeedTestInputError(`A seed test accepts at most ${SEED_TEST_MAX_SEEDS} seeds.`);
	}
	const seeds: string[] = [];
	for (const seed of rawSeeds) {
		if (typeof seed !== 'string' || seed.trim().length === 0) {
			throw new SeedTestInputError('Every seed must be a non-empty string.');
		}
		seeds.push(seed.trim().toLowerCase());
	}

	const subject = readString(object, 'subject');
	const body = `${readString(object, 'text')} ${readString(object, 'html')}`;
	const penalty = Math.min(spamSignal(subject, body) * 15, 60);

	let inbox = 0;
	let promotions = 0;
	let spam = 0;
	const placements: SeedPlacement[] = seeds.map((address) => {
		const adjusted = bucketOf(`${address}|${subject}`) - penalty;
		const folder: SeedFolder = adjusted < 20 ? 'spam' : adjusted < 55 ? 'promotions' : 'inbox';
		if (folder === 'inbox') inbox += 1;
		else if (folder === 'promotions') promotions += 1;
		else spam += 1;
		return { address, folder };
	});

	const result: SeedTestResult = {
		seeds: seeds.length,
		inbox,
		promotions,
		spam,
		placementRate: seeds.length === 0 ? 0 : inbox / seeds.length,
		placements,
	};
	return JSON.stringify(result);
}
