/**
 * One rollout at a time, and a record of how the last update ended.
 *
 * /update waits for readiness after `up`, which can take minutes. While it
 * does, a second /update, an /apply-profiles, a /rotate-env or a
 * /configure-ip would run its own `docker compose up` against the same stack
 * and rewrite the same `.env`: two recreates racing each other, one request's
 * `.env` edit lost to the other's read-modify-write, and a readiness verdict
 * about a stack the other request just changed. So the four endpoints that
 * recreate containers share one lock and answer 409 while another holds it.
 *
 * The /update answer rarely reaches its caller: `up` recreates the web
 * container that sent the request. The verdict is therefore also written to
 * the install directory and served from /health, which the browser keeps
 * polling across the restart. It survives the updater's own replacement at
 * the end of the rollout because it is on the host, not in this process.
 */
import type { ServerResponse } from 'node:http';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { json, OWLAT_DIR } from './http.js';

export type RolloutKind = 'update' | 'apply-profiles' | 'rotate-env' | 'configure-ip';

const KIND_LABEL: Record<RolloutKind, string> = {
	update: 'an update',
	'apply-profiles': 'a feature change',
	'rotate-env': 'a secret rotation',
	'configure-ip': 'an IP pool change',
};

let inFlight: { kind: RolloutKind; since: number } | null = null;

/** Which rollout is running in this process right now, if any. */
export function rolloutInProgress(): RolloutKind | null {
	return inFlight?.kind ?? null;
}

/**
 * Run `fn` holding the rollout lock, or answer 409 when another rollout
 * holds it. Callers authenticate first, so an anonymous request learns
 * nothing about work in flight.
 */
export async function exclusively(
	kind: RolloutKind,
	res: ServerResponse,
	fn: () => Promise<void>
): Promise<void> {
	if (inFlight) {
		const seconds = Math.round((Date.now() - inFlight.since) / 1000);
		json(res, 409, {
			error:
				`The updater is still applying ${KIND_LABEL[inFlight.kind]} (started ${seconds}s ago). ` +
				'Try again once it has finished.',
			inProgress: inFlight.kind,
		});
		return;
	}
	inFlight = { kind, since: Date.now() };
	try {
		await fn();
	} finally {
		inFlight = null;
	}
}

/**
 * How an update ended, from the recreate on (see update.ts) or before it.
 * `interrupted`: the updater stopped before the update reached a verdict.
 */
export type RolloutOutcome = 'healthy' | 'started' | 'partially-applied' | 'failed' | 'interrupted';

export interface LastRollout {
	/** The caller's id for this update, when it sent one. */
	attempt?: string;
	/** The release the update applied; null for an update without a template. */
	targetVersion: string | null;
	startedAt: number;
	/** `verifying` is the readiness wait after `up`. */
	phase: 'applying' | 'verifying' | 'done';
	/**
	 * Set once the update started changing what the host runs: the compose file
	 * is promoted (or, without a template, `up` is about to run). Before it, an
	 * interrupted update left the running stack as it was; after it, the
	 * configuration names the new release and the containers may lag behind.
	 */
	committed?: boolean;
	outcome?: RolloutOutcome;
	summary?: string;
	warnings?: string[];
	finishedAt?: number;
}

const RECORD_FILE = join(OWLAT_DIR, '.owlat-last-rollout.json');

const ATTEMPT_ID = /^[A-Za-z0-9-]{8,64}$/;

/** An attempt id is echoed back verbatim, so only a plain token is kept. */
export function isAttemptId(value: unknown): value is string {
	return typeof value === 'string' && ATTEMPT_ID.test(value);
}

/**
 * Persist `record`. Best-effort: losing it costs the browser its verdict after
 * a restart (it then falls back to comparing image tags), never the update.
 */
export function writeLastRollout(record: LastRollout): void {
	const tmp = `${RECORD_FILE}.tmp`;
	try {
		writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
		renameSync(tmp, RECORD_FILE);
	} catch (err) {
		console.error('[update] could not record the rollout state:', err);
	}
}

function isLastRollout(value: unknown): value is LastRollout {
	if (typeof value !== 'object' || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		(typeof record['targetVersion'] === 'string' || record['targetVersion'] === null) &&
		typeof record['startedAt'] === 'number' &&
		['applying', 'verifying', 'done'].includes(record['phase'] as string)
	);
}

/**
 * What an update that never reached a verdict left behind, in words the
 * operator can act on. Whether it had committed is the whole difference.
 */
export function interruptedVerdict(record: LastRollout): LastRollout {
	return {
		...record,
		phase: 'done',
		outcome: 'interrupted',
		summary: record.committed
			? 'The updater stopped after the release was promoted, before it confirmed the ' +
				'containers were recreated. Run the update again, or `docker compose up -d` in the ' +
				'install directory on the host, to finish it.'
			: 'The updater stopped before the release was applied. The running stack was not ' +
				'changed; run the update again.',
	};
}

/**
 * The last update's record, as /health reports it. A record still in flight
 * while no update runs in this process belongs to an updater that stopped
 * mid-rollout, so it is reported as interrupted rather than as still going.
 */
export function readLastRollout(): LastRollout | null {
	const record = readRecord();
	if (!record) return null;
	if (record.phase !== 'done' && inFlight?.kind !== 'update') return interruptedVerdict(record);
	return record;
}

/** The record as it is on disk, or null when there is none worth reading. */
export function readRecord(): LastRollout | null {
	let record: unknown;
	try {
		record = JSON.parse(readFileSync(RECORD_FILE, 'utf-8'));
	} catch {
		return null;
	}
	return isLastRollout(record) ? record : null;
}
