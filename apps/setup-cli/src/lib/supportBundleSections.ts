/**
 * What each section of `owlat-setup support-bundle` may carry off the box.
 *
 * A support bundle is attached to a public issue or mailed to someone outside
 * the install, so every section is an allowlist projection: fields are copied
 * only from known keys and only when the value has the shape the key promises
 * (a version token, a compose service name, a timestamp). Anything else is
 * dropped, never passed through "because it looked harmless". Pure: the
 * command in `commands/supportBundle.ts` does the I/O and hands the raw output
 * of each source here.
 */

import type { ComposeService } from '@owlat/shared/containerHealth';
import { projectLogLineForExport, redactEmailAddress } from '@owlat/shared/logRedaction';
import type { DoctorReport } from './doctorReport';

/** Bumped only for a breaking change to a section's shape. */
export const SUPPORT_BUNDLE_SCHEMA_VERSION = 1;

/**
 * `ok`: collected. `absent`: the source exists but holds nothing (no rollout
 * has run yet). `unavailable`: the source could not be read; `reason` says why.
 */
export type SectionStatus = 'ok' | 'absent' | 'unavailable';

export type SectionReason =
	| 'docker_unavailable'
	| 'command_failed'
	| 'timed_out'
	| 'output_too_large'
	| 'unparseable'
	| 'invalid_record'
	| 'unreadable'
	| 'collection_failed';

export interface SectionResult {
	status: SectionStatus;
	reason?: SectionReason;
}

const VERSION_TOKEN = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/;
/** Compose service names: `[a-zA-Z0-9._-]`, starting with a letter or digit. */
const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,199}$/;
/** Docker's own status line: `Up 3 hours (healthy)`, `Exited (1) 2 minutes ago`. */
const DOCKER_STATUS = /^[A-Za-z0-9 ().,:_-]{0,80}$/;
const LOWER_TOKEN = /^[a-z][a-z0-9_-]{0,31}$/;
const MIGRATION_NAME = /^[0-9]{4}_[a-z0-9_]{1,80}$/;
const DOCKER_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
/** An email address anywhere inside a runtime string. */
const EMBEDDED_ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*/g;

function token(value: unknown, pattern: RegExp): string | null {
	return typeof value === 'string' && pattern.test(value) ? value : null;
}

function finiteNumber(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A version string as a bundle may report it, or null. */
export function versionToken(value: string | undefined | null): string | null {
	const trimmed = value?.trim().replace(/^['"]|['"]$/g, '') ?? '';
	return VERSION_TOKEN.test(trimmed) ? trimmed : null;
}

export function isBundleServiceName(name: string): boolean {
	return SERVICE_NAME.test(name);
}

// ── Compose status ──────────────────────────────────────────────────────────

export interface BundleComposeService {
	service: string;
	state: string | null;
	status: string | null;
	health: string | null;
	image: string | null;
	imageTag: string | null;
}

/** Rows of `docker compose ps --all`, with every field shape-checked. Rows without a usable service name are dropped. */
export function projectComposeServices(
	services: readonly ComposeService[]
): BundleComposeService[] {
	const rows: BundleComposeService[] = [];
	for (const row of services) {
		if (!isBundleServiceName(row.service)) continue;
		rows.push({
			service: row.service,
			state: token(row.state, LOWER_TOKEN),
			status: token(row.status, DOCKER_STATUS),
			health: token(row.health, LOWER_TOKEN),
			image: token(row.image, IMAGE_REF),
			imageTag: versionToken(row.imageTag),
		});
	}
	return rows.sort((a, b) => a.service.localeCompare(b.service));
}

// ── Doctor ──────────────────────────────────────────────────────────────────

const DOCTOR_SUBJECT = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * The doctor report as the bundle collects it: `collectDoctorReport` with
 * `codeOwnedMessages`, so each message is already reduced to code-owned text
 * with every run of runtime text (MTA answers, docker status lines, error
 * messages) replaced by `[redacted]`, and a file in the install directory
 * named as `<install dir>/<file>`. Here, on top of that, a subject is kept
 * only when it is an identifier (env key, IP, service) and dropped otherwise,
 * and an email-shaped string left in a message (a code-owned path or key name
 * never holds one) is still de-identified.
 */
export function projectDoctorReport(report: DoctorReport): DoctorReport {
	return {
		...report,
		activeFeatures: report.activeFeatures.filter((feature) => DOCTOR_SUBJECT.test(feature)),
		checks: report.checks.map(({ subject, ...check }) => ({
			...check,
			...(subject !== undefined && DOCTOR_SUBJECT.test(subject) ? { subject } : {}),
			message: check.message.replace(EMBEDDED_ADDRESS, (address) => redactEmailAddress(address)),
		})),
	};
}

// ── Migration ledger ────────────────────────────────────────────────────────

const MIGRATION_STATES = new Set(['pending', 'running', 'failed', 'interrupted', 'completed']);
const RUNNER_STATES = new Set(['active', 'finished', 'stopped']);

export interface BundleMigration {
	migration: string;
	introducedIn: string | null;
	state: string;
	stalledAt: number | null;
	hasError: boolean;
	startedAt: number | null;
	updatedAt: number | null;
	completedAt: number | null;
	pageCount: number | null;
	scannedCount: number | null;
	changedCount: number | null;
}

export interface BundleMigrationState {
	deployedVersion: string | null;
	migrations: BundleMigration[];
	runner: {
		status: string;
		startedAt: number | null;
		updatedAt: number | null;
		finishedAt: number | null;
		stoppedMigration: string | null;
		hasStoppedError: boolean;
	} | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The output of `convex run migrations/admin:supportBundleState`, re-checked
 * here: the backend is a separate release from this CLI, so its answer is
 * input like any other. Null when it is not that query's shape at all.
 */
export function projectMigrationState(stdout: string): BundleMigrationState | null {
	const text = stdout.trim();
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		// The Convex CLI may print notices around the value; take the outermost object.
		const open = text.indexOf('{');
		const close = text.lastIndexOf('}');
		if (open === -1 || close <= open) return null;
		try {
			value = JSON.parse(text.slice(open, close + 1));
		} catch {
			return null;
		}
	}
	if (!isObject(value) || !Array.isArray(value['migrations'])) return null;
	const migrations: BundleMigration[] = [];
	for (const row of value['migrations']) {
		if (!isObject(row)) continue;
		const migration = token(row['migration'], MIGRATION_NAME);
		const state = typeof row['state'] === 'string' ? row['state'] : '';
		if (!migration || !MIGRATION_STATES.has(state)) continue;
		migrations.push({
			migration,
			introducedIn: versionToken(
				typeof row['introducedIn'] === 'string' ? row['introducedIn'] : null
			),
			state,
			stalledAt: finiteNumber(row['stalledAt']),
			hasError: row['hasError'] === true,
			startedAt: finiteNumber(row['startedAt']),
			updatedAt: finiteNumber(row['updatedAt']),
			completedAt: finiteNumber(row['completedAt']),
			pageCount: finiteNumber(row['pageCount']),
			scannedCount: finiteNumber(row['scannedCount']),
			changedCount: finiteNumber(row['changedCount']),
		});
	}
	const runner = value['runner'];
	const runnerStatus =
		isObject(runner) && typeof runner['status'] === 'string' ? runner['status'] : '';
	return {
		deployedVersion: versionToken(
			typeof value['deployedVersion'] === 'string' ? value['deployedVersion'] : null
		),
		migrations,
		runner:
			isObject(runner) && RUNNER_STATES.has(runnerStatus)
				? {
						status: runnerStatus,
						startedAt: finiteNumber(runner['startedAt']),
						updatedAt: finiteNumber(runner['updatedAt']),
						finishedAt: finiteNumber(runner['finishedAt']),
						stoppedMigration: token(runner['stoppedMigration'], MIGRATION_NAME),
						hasStoppedError: runner['hasStoppedError'] === true,
					}
				: null,
	};
}

// ── Last rollout ────────────────────────────────────────────────────────────

const ROLLOUT_PHASES = new Set(['applying', 'verifying', 'done']);
const ROLLOUT_OUTCOMES = new Set([
	'healthy',
	'started',
	'partially-applied',
	'failed',
	'interrupted',
]);

export interface BundleRollout {
	targetVersion: string | null;
	startedAt: number;
	finishedAt: number | null;
	phase: string;
	committed: boolean | null;
	outcome: string | null;
	warningCount: number;
	hasSummary: boolean;
}

/**
 * The updater's `.owlat-last-rollout.json` (apps/updater/src/rolloutState.ts
 * writes it), read without importing the updater. The summary and warnings are
 * prose that can quote command output, so only their presence and count are
 * kept. A record still `applying`/`verifying` is reported as such: whether an
 * update is running right now is the updater's knowledge, not this file's.
 */
export function projectRolloutRecord(text: string | null): {
	result: SectionResult;
	rollout: BundleRollout | null;
} {
	if (text === null) return { result: { status: 'absent' }, rollout: null };
	let record: unknown;
	try {
		record = JSON.parse(text);
	} catch {
		return { result: { status: 'unavailable', reason: 'invalid_record' }, rollout: null };
	}
	if (
		!isObject(record) ||
		!(typeof record['targetVersion'] === 'string' || record['targetVersion'] === null) ||
		typeof record['startedAt'] !== 'number' ||
		!ROLLOUT_PHASES.has(record['phase'] as string)
	) {
		return { result: { status: 'unavailable', reason: 'invalid_record' }, rollout: null };
	}
	const outcome = typeof record['outcome'] === 'string' ? record['outcome'] : '';
	return {
		result: { status: 'ok' },
		rollout: {
			targetVersion: versionToken(record['targetVersion'] as string | null),
			startedAt: record['startedAt'],
			finishedAt: finiteNumber(record['finishedAt']),
			phase: record['phase'] as string,
			committed: typeof record['committed'] === 'boolean' ? record['committed'] : null,
			outcome: ROLLOUT_OUTCOMES.has(outcome) ? outcome : null,
			warningCount: Array.isArray(record['warnings']) ? record['warnings'].length : 0,
			hasSummary: typeof record['summary'] === 'string' && record['summary'].length > 0,
		},
	};
}

// ── Logs ────────────────────────────────────────────────────────────────────

export interface ProjectedServiceLog {
	/** One JSON object per line. */
	ndjson: string;
	lines: number;
}

/**
 * `docker compose logs --no-log-prefix --timestamps --tail N <service>` output
 * as NDJSON of {@link projectLogLineForExport} records, each with docker's
 * timestamp as `t` when it has one. At most `maxLines`, newest kept.
 */
export function projectServiceLog(raw: string, maxLines: number): ProjectedServiceLog {
	const lines = raw.split('\n').filter((line) => line.trim().length > 0);
	const kept = lines.slice(-maxLines);
	const out: string[] = [];
	for (const line of kept) {
		const space = line.indexOf(' ');
		const stamp = space > 0 ? line.slice(0, space) : '';
		const hasStamp = DOCKER_TIMESTAMP.test(stamp);
		const content = hasStamp ? line.slice(space + 1) : line;
		out.push(
			JSON.stringify({ ...(hasStamp ? { t: stamp } : {}), ...projectLogLineForExport(content) })
		);
	}
	return { ndjson: out.length > 0 ? `${out.join('\n')}\n` : '', lines: out.length };
}
