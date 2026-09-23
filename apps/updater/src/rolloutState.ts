/**
 * One rollout at a time, and a record of how the last update ended.
 *
 * /update waits for readiness after `up`, which can take minutes. While it
 * does, a second /update, an /apply-profiles or a /rotate-env would run its
 * own `docker compose up` against the same stack and the same `.env`: two
 * recreates racing each other, and a readiness verdict about a stack the
 * other request just changed. So the three state-changing endpoints share one
 * lock and answer 409 while another holds it.
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

type RolloutKind = 'update' | 'apply-profiles' | 'rotate-env';

const KIND_LABEL: Record<RolloutKind, string> = {
	update: 'an update',
	'apply-profiles': 'a feature change',
	'rotate-env': 'a secret rotation',
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

/** How an update ended, from the recreate on (see update.ts) or before it. */
export type RolloutOutcome = 'healthy' | 'started' | 'partially-applied' | 'failed';

export interface LastRollout {
	/** The caller's id for this update, when it sent one. */
	attempt?: string;
	/** The release the update applied; null for an update without a template. */
	targetVersion: string | null;
	startedAt: number;
	/** `verifying` is the readiness wait after `up`. */
	phase: 'applying' | 'verifying' | 'done';
	/** `interrupted`: the updater stopped before the update reached a verdict. */
	outcome?: RolloutOutcome | 'interrupted';
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
 * The last update's record, as /health reports it. A record still in flight
 * while no update runs in this process belongs to an updater that stopped
 * mid-rollout, so it is reported as interrupted rather than as still going.
 */
export function readLastRollout(): LastRollout | null {
	let record: unknown;
	try {
		record = JSON.parse(readFileSync(RECORD_FILE, 'utf-8'));
	} catch {
		return null;
	}
	if (!isLastRollout(record)) return null;
	if (record.phase !== 'done' && inFlight?.kind !== 'update') {
		return {
			...record,
			phase: 'done',
			outcome: 'interrupted',
			summary:
				'The updater stopped before the update reached a verdict. ' +
				'Check `docker compose ps` on the host.',
		};
	}
	return record;
}
