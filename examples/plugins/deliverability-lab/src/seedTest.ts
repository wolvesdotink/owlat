/**
 * Tier-3 seed-list test — the PLUGIN side of the sandboxed job.
 *
 * A seed test is heavier than the synchronous engine: it fans a rendered email
 * out across a seed-inbox list and reports where each landed (inbox /
 * promotions / spam). That is exactly the kind of untrusted, potentially slow
 * compute Tier 3 exists for, so the plugin does not run it in-process — it
 * ENQUEUES a job onto the PP-27 sandboxed worker queue. This module owns the
 * plugin's half of that contract:
 *
 *   - `buildSeedTestPayload` produces the `{ jobKind, payload }` the host's
 *     `plugins/workerTasks:enqueue` seam accepts. The job kind is namespaced to
 *     THIS plugin (`plugin.deliverability-lab.seed-test`) via the shared kernel
 *     helper, so the host's enqueue authorization can prove ownership from the
 *     string alone, and the payload is bounded to the host's byte ceiling here
 *     (the host re-checks and rejects an oversized payload regardless).
 *   - `parseSeedTestResult` re-validates the worker's completed result. The
 *     worker's output is untrusted plugin text even after the host clamps it, so
 *     the plugin never trusts a field it did not validate.
 *
 * The wire shapes below are the SAME contract the worker's `runSeedTest`
 * (apps/code-worker) reads and writes; a shared fixture pins the two sides.
 */

import {
	PLUGIN_WORKER_PAYLOAD_MAX_BYTES,
	pluginWorkerJobKind,
	type PluginWorkerJobKind,
} from '@owlat/plugin-kit';
import type { DeliverabilityEmail } from './engine';
import { DELIVERABILITY_LAB_PLUGIN_ID } from './constants';

/** Local id of the seed-test job kind; the host namespaces it with the plugin id. */
export const SEED_TEST_LOCAL_ID = 'seed-test';

/** Upper bound on seed addresses per job — keeps one job's compute bounded. */
export const SEED_TEST_MAX_SEEDS = 50;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The untrusted job payload the worker's `runSeedTest` parses. */
export interface SeedTestPayload {
	readonly subject: string;
	readonly from: string;
	readonly html?: string;
	readonly text?: string;
	readonly seeds: readonly string[];
}

/** Where a single seed landed. */
export type SeedFolder = 'inbox' | 'promotions' | 'spam';

/** One seed's placement in the completed result. */
export interface SeedPlacement {
	readonly address: string;
	readonly folder: SeedFolder;
}

/** The completed seed-test result the worker writes and the plugin re-validates. */
export interface SeedTestResult {
	readonly seeds: number;
	readonly inbox: number;
	readonly promotions: number;
	readonly spam: number;
	/** Fraction that reached the inbox, in [0,1]. */
	readonly placementRate: number;
	readonly placements: readonly SeedPlacement[];
}

/** Thrown by {@link buildSeedTestPayload} when the request cannot be enqueued. */
export class SeedTestPayloadError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SeedTestPayloadError';
	}
}

export interface SeedTestEnqueueRequest {
	readonly jobKind: PluginWorkerJobKind;
	readonly payload: string;
}

/**
 * Build the enqueue request for a seed test. Validates and de-duplicates the
 * seed list, then bounds the serialized payload to the host's byte ceiling —
 * throwing {@link SeedTestPayloadError} rather than emitting a payload the host
 * would reject at enqueue.
 */
export function buildSeedTestPayload(
	email: DeliverabilityEmail,
	seeds: readonly string[]
): SeedTestEnqueueRequest {
	const unique = [...new Set(seeds.map((seed) => seed.trim().toLowerCase()))].filter(
		(seed) => seed.length > 0
	);
	if (unique.length === 0) {
		throw new SeedTestPayloadError('A seed test needs at least one seed address.');
	}
	if (unique.length > SEED_TEST_MAX_SEEDS) {
		throw new SeedTestPayloadError(
			`A seed test accepts at most ${SEED_TEST_MAX_SEEDS} seed addresses.`
		);
	}
	const invalid = unique.find((seed) => !EMAIL_RE.test(seed));
	if (invalid !== undefined) {
		throw new SeedTestPayloadError(`Not a valid seed address: ${invalid}`);
	}

	const payloadObject: SeedTestPayload = {
		subject: email.subject,
		from: email.from,
		...(email.html !== undefined ? { html: email.html } : {}),
		...(email.text !== undefined ? { text: email.text } : {}),
		seeds: unique,
	};
	const payload = JSON.stringify(payloadObject);
	if (Buffer.byteLength(payload) > PLUGIN_WORKER_PAYLOAD_MAX_BYTES) {
		throw new SeedTestPayloadError(
			'Rendered email is too large to seed-test; trim the content and retry.'
		);
	}

	return {
		jobKind: pluginWorkerJobKind(DELIVERABILITY_LAB_PLUGIN_ID, SEED_TEST_LOCAL_ID),
		payload,
	};
}

function readFolder(value: unknown): SeedFolder | null {
	return value === 'inbox' || value === 'promotions' || value === 'spam' ? value : null;
}

function readCount(object: Record<string, unknown>, key: string): number | null {
	const value = object[key];
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Strictly parse the worker's completed result JSON. Returns `null` on anything
 * malformed so a caller fails closed rather than trusting a shape it did not
 * validate — the worker's output is untrusted even after the host clamps it.
 */
export function parseSeedTestResult(resultJson: string): SeedTestResult | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(resultJson);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
	const object = parsed as Record<string, unknown>;

	const seeds = readCount(object, 'seeds');
	const inbox = readCount(object, 'inbox');
	const promotions = readCount(object, 'promotions');
	const spam = readCount(object, 'spam');
	if (seeds === null || inbox === null || promotions === null || spam === null) return null;
	if (inbox + promotions + spam !== seeds) return null;

	const rate = object['placementRate'];
	if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 1) return null;

	const rawPlacements = object['placements'];
	if (!Array.isArray(rawPlacements) || rawPlacements.length !== seeds) return null;
	const placements: SeedPlacement[] = [];
	for (const entry of rawPlacements) {
		if (entry === null || typeof entry !== 'object') return null;
		const record = entry as Record<string, unknown>;
		const address = record['address'];
		const folder = readFolder(record['folder']);
		if (typeof address !== 'string' || folder === null) return null;
		placements.push({ address, folder });
	}

	return { seeds, inbox, promotions, spam, placementRate: rate, placements };
}
