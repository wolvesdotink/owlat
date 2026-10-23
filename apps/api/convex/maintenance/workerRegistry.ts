/**
 * The worker registry: which releases of each separately deployed worker
 * (IMAP server, mail-sync, MTA, code-worker) call this backend, and whether
 * the backend still serves their wire contract (`@owlat/shared/workerWire`).
 *
 * - `report`: a worker's report, at its startup and every 5 minutes after.
 *   mail-sync calls it with the admin key; the MTA reaches it through the
 *   signed `/webhooks/mta-worker-report` route (`workerReportHttp.ts`); the
 *   IMAP server's `mail/imap/serverRegistry:report` records here too.
 * - `reportCodeWorker`: the code-worker's report. The code-worker reaches the
 *   backend only through an allowlisting proxy and runs untrusted code, so its
 *   entry point records nothing but a code-worker row.
 * - `status` / `getForAdmin`: per service, the reported builds, their verdicts
 *   and the lowest and highest wire version seen, for the operator
 *   (`npx convex run maintenance/workerRegistry:status '{"days": 7}'`) and
 *   Settings → System & updates.
 * - {@link readWorkerWaits}: whether every worker has moved to the versions a
 *   contract step needs. The migration runner holds such a step until it has.
 * - `pruneStale`: the daily cron that drops reports older than 30 days.
 */

import { v } from 'convex/values';
import {
	WORKER_REPORT_INTERVAL_MS,
	WORKER_SERVICES,
	WORKER_WIRE_LEGACY,
	workerWireReportResult,
	workerWireVerdict,
	workerWireWindow,
	type WorkerService,
	type WorkerWireReportResult,
	type WorkerWireVerdict,
} from '@owlat/shared/workerWire';
import { internalQuery, type DatabaseReader, type MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { internalMutation } from '../lib/writeFence';
import { platformAdminQuery } from '../lib/authedFunctions';
import { DAY_MS } from '../lib/constants';
import { getOptional, type EnvKey } from '../lib/env';
import { readInstanceCounter } from '../lib/instanceCounters';
import { throwInvalidInput } from '../_utils/errors';

/** Reports not refreshed for this long are deleted. */
export const WORKER_SERVER_RETENTION_MS = 30 * DAY_MS;

/**
 * A worker that has not reported for three report intervals is not running: a
 * live one reports every 5 minutes. What a contract step waits on.
 */
export const WORKER_LIVE_WINDOW_MS = 3 * WORKER_REPORT_INTERVAL_MS;

/** The default status window, and its bounds. */
const DEFAULT_WINDOW_DAYS = 7;
const MAX_WINDOW_DAYS = 30;

/** Upper bound on rows a status read lists per service (one per host and build). */
const MAX_LISTED_PER_SERVICE = 50;

const PRUNE_BATCH = 200;

/**
 * Distinct wire versions probed before giving up. Rows live at most 30 days and
 * a release bumps a version at most once, so a handful exist in practice.
 */
const MAX_WIRE_PROBES = 32;

/** Reported strings are labels, not data: clamp them. */
const MAX_LABEL_LENGTH = 64;

const clampLabel = (value: string, fallback: string) =>
	value.trim().slice(0, MAX_LABEL_LENGTH) || fallback;

export const workerServiceValidator = v.union(
	v.literal('imap'),
	v.literal('mail-sync'),
	v.literal('mta'),
	v.literal('code-worker')
);

const reportFields = {
	instanceId: v.string(),
	hostLabel: v.string(),
	owlatVersion: v.string(),
	wireVersion: v.number(),
	startedAt: v.number(),
};

export interface WorkerReport {
	instanceId: string;
	hostLabel: string;
	owlatVersion: string;
	wireVersion: number;
	startedAt: number;
}

/**
 * Upsert one worker's report (one row per service, host and build) and answer
 * with the backend's side of that service's contract.
 */
export async function recordWorkerReport(
	ctx: MutationCtx,
	service: WorkerService,
	report: WorkerReport,
	now: number = Date.now()
): Promise<WorkerWireReportResult> {
	if (!Number.isSafeInteger(report.wireVersion) || report.wireVersion < 0) {
		throwInvalidInput('wireVersion must be a non-negative integer', {
			wireVersion: report.wireVersion,
		});
	}
	const hostLabel = clampLabel(report.hostLabel, 'unknown');
	const owlatVersion = clampLabel(report.owlatVersion, 'dev');
	const fields = {
		instanceId: clampLabel(report.instanceId, 'unknown'),
		startedAt: report.startedAt,
		lastSeenAt: now,
	};
	const existing = await ctx.db
		.query('workerServers')
		.withIndex('by_service_and_host_and_build', (q) =>
			q
				.eq('service', service)
				.eq('hostLabel', hostLabel)
				.eq('owlatVersion', owlatVersion)
				.eq('wireVersion', report.wireVersion)
		)
		.first(); // bounded: one row per service, host and build
	if (existing) await ctx.db.patch(existing._id, fields);
	else {
		await ctx.db.insert('workerServers', {
			...fields,
			service,
			hostLabel,
			owlatVersion,
			wireVersion: report.wireVersion,
		});
	}
	return workerWireReportResult(report.wireVersion, workerWireWindow(service));
}

/** A worker's report: mail-sync with the admin key, the MTA through its signed route. */
export const report = internalMutation({
	args: { service: workerServiceValidator, ...reportFields },
	handler: async (ctx, { service, ...args }): Promise<WorkerWireReportResult> =>
		recordWorkerReport(ctx, service, args),
});

/**
 * The code-worker's report. Separate from {@link report} so the proxy's
 * allowlist lets an untrusted task reach nothing but the code-worker's own row.
 */
export const reportCodeWorker = internalMutation({
	args: reportFields,
	handler: async (ctx, args): Promise<WorkerWireReportResult> =>
		recordWorkerReport(ctx, 'code-worker', args),
});

// ── Status ───────────────────────────────────────────────────────────────────

const WIRE_INDEX = 'by_service_and_wire_version_and_last_seen_at';

/**
 * The lowest wire version `service` reported since `since`, over every row,
 * not just the listed ones: per distinct version, one read finds the version
 * and one checks it for a report inside the window. Past the probe budget it
 * answers legacy, which no contract step accepts.
 */
async function oldestWireVersionSince(
	db: DatabaseReader,
	service: WorkerService,
	since: number
): Promise<number | null> {
	let after: number | undefined;
	for (let probe = 0; probe < MAX_WIRE_PROBES; probe++) {
		const floor = after;
		const next = await db
			.query('workerServers')
			.withIndex(WIRE_INDEX, (q) =>
				floor === undefined
					? q.eq('service', service)
					: q.eq('service', service).gt('wireVersion', floor)
			)
			.first();
		if (!next) return null;
		const inWindow = await db
			.query('workerServers')
			.withIndex(WIRE_INDEX, (q) =>
				q.eq('service', service).eq('wireVersion', next.wireVersion).gte('lastSeenAt', since)
			)
			.first();
		if (inWindow) return next.wireVersion;
		after = next.wireVersion;
	}
	return WORKER_WIRE_LEGACY;
}

/**
 * The highest wire version `service` reported since `since`. Walking down,
 * each version's last row is its latest report, so one read per version.
 */
async function newestWireVersionSince(
	db: DatabaseReader,
	service: WorkerService,
	since: number
): Promise<number | null> {
	let below: number | undefined;
	for (let probe = 0; probe < MAX_WIRE_PROBES; probe++) {
		const ceiling = below;
		const next = await db
			.query('workerServers')
			.withIndex(WIRE_INDEX, (q) =>
				ceiling === undefined
					? q.eq('service', service)
					: q.eq('service', service).lt('wireVersion', ceiling)
			)
			.order('desc')
			.first();
		if (!next) return null;
		if (next.lastSeenAt >= since) return next.wireVersion;
		below = next.wireVersion;
	}
	return null;
}

export interface WorkerServiceStatus {
	service: WorkerService;
	backendWireVersion: number;
	minSupportedWireVersion: number;
	servers: Array<{
		instanceId: string;
		hostLabel: string;
		owlatVersion: string;
		wireVersion: number;
		startedAt: number;
		lastSeenAt: number;
		verdict: WorkerWireVerdict;
		/** Reported within {@link WORKER_LIVE_WINDOW_MS}. */
		isLive: boolean;
	}>;
	/** `servers` holds the most recent rows only; the summary fields cover every row. */
	isListTruncated: boolean;
	/** The lowest wire version seen in the window (an IMAP legacy login counting as 0); null if none. */
	oldestWireVersionSeen: number | null;
	/** The highest wire version reported in the window; null if none. */
	newestWireVersionSeen: number | null;
	/** IMAP only: the last login through a pre-reporting IMAP server; null if none, or another service. */
	legacySeenAt: number | null;
	isLegacyInWindow: boolean;
}

export interface WorkerRegistryStatus {
	windowDays: number;
	liveWindowMs: number;
	/** Every service, in `WORKER_SERVICES` order, reported or not. */
	services: WorkerServiceStatus[];
}

async function readServiceStatus(
	db: DatabaseReader,
	service: WorkerService,
	now: number,
	since: number
): Promise<WorkerServiceStatus> {
	const window = workerWireWindow(service);
	// The list is for display and is capped; the summary below is not derived
	// from it.
	const rows = await db
		.query('workerServers')
		.withIndex('by_service_and_last_seen_at', (q) =>
			q.eq('service', service).gte('lastSeenAt', since)
		)
		.order('desc')
		.take(MAX_LISTED_PER_SERVICE + 1);
	const servers = rows.slice(0, MAX_LISTED_PER_SERVICE).map((row) => ({
		instanceId: row.instanceId,
		hostLabel: row.hostLabel,
		owlatVersion: row.owlatVersion,
		wireVersion: row.wireVersion,
		startedAt: row.startedAt,
		lastSeenAt: row.lastSeenAt,
		verdict: workerWireVerdict(row.wireVersion, window),
		isLive: row.lastSeenAt >= now - WORKER_LIVE_WINDOW_MS,
	}));

	let legacySeenAt: number | null = null;
	if (service === 'imap') {
		legacySeenAt = (await readInstanceCounter(db, 'imapLegacy')).legacyImapSeenAt ?? null;
	}
	const isLegacyInWindow = legacySeenAt !== null && legacySeenAt >= since;

	const oldestReported = await oldestWireVersionSince(db, service, since);
	const seen = oldestReported === null ? [] : [oldestReported];
	if (isLegacyInWindow) seen.push(WORKER_WIRE_LEGACY);

	return {
		service,
		backendWireVersion: window.current,
		minSupportedWireVersion: window.minSupported,
		servers,
		isListTruncated: rows.length > MAX_LISTED_PER_SERVICE,
		oldestWireVersionSeen: seen.length > 0 ? Math.min(...seen) : null,
		newestWireVersionSeen: await newestWireVersionSince(db, service, since),
		legacySeenAt,
		isLegacyInWindow,
	};
}

export async function readWorkerRegistryStatus(
	db: DatabaseReader,
	now: number,
	days: number = DEFAULT_WINDOW_DAYS
): Promise<WorkerRegistryStatus> {
	const windowDays = Math.min(Math.max(Math.floor(days), 1), MAX_WINDOW_DAYS);
	const since = now - windowDays * DAY_MS;
	const services: WorkerServiceStatus[] = [];
	for (const service of WORKER_SERVICES) {
		services.push(await readServiceStatus(db, service, now, since));
	}
	return { windowDays, liveWindowMs: WORKER_LIVE_WINDOW_MS, services };
}

/** Operator status: `npx convex run maintenance/workerRegistry:status '{"days": 7}'`. */
export const status = internalQuery({
	args: { days: v.optional(v.number()) },
	handler: async (ctx, args): Promise<WorkerRegistryStatus> =>
		readWorkerRegistryStatus(ctx.db, Date.now(), args.days),
});

/** The last 7 days for Settings → System & updates. */
export const getForAdmin = platformAdminQuery({
	args: {},
	handler: async (ctx): Promise<WorkerRegistryStatus> =>
		readWorkerRegistryStatus(ctx.db, Date.now()),
});

// ── Contract steps ───────────────────────────────────────────────────────────

/** The wire version per service a contract step needs every worker to have reached. */
export type WorkerRequirement = Readonly<Partial<Record<WorkerService, number>>>;

/**
 * Why a contract step still waits on a service:
 * - `lagging`: a live worker reports a lower wire version.
 * - `missing`: no live worker has reported the required version, and the
 *   service runs here (it is configured, or reported in the last 7 days).
 */
export interface WorkerWait {
	service: WorkerService;
	requiredWireVersion: number;
	reason: 'lagging' | 'missing';
	/** The lowest wire version a live worker reports; null when none is live. */
	oldestLiveWireVersion: number | null;
}

/**
 * The setting that points the backend at a service it calls. The IMAP server
 * and the code-worker only call in and have none: their reports are the only
 * evidence that they run.
 */
const SERVICE_URL_SETTING: Readonly<Partial<Record<WorkerService, EnvKey>>> = {
	mta: 'MTA_API_URL',
	'mail-sync': 'MAIL_SYNC_API_URL',
};

function isServiceConfigured(service: WorkerService): boolean {
	const setting = SERVICE_URL_SETTING[service];
	return setting !== undefined && Boolean(getOptional(setting));
}

/**
 * The services that have not moved to `requirement` yet; empty when every
 * worker has. Read per version off the index, never off a capped list, so a
 * lagging worker among many still holds the step.
 *
 * A worker from before reporting is invisible here. For the MTA and mail-sync
 * the backend's own configuration still names them (so they read as
 * `missing`); for the others the supported skew window is what keeps them out.
 */
export async function readWorkerWaits(
	db: DatabaseReader,
	requirement: WorkerRequirement,
	now: number
): Promise<WorkerWait[]> {
	const waits: WorkerWait[] = [];
	for (const service of WORKER_SERVICES) {
		const requiredWireVersion = requirement[service];
		if (requiredWireVersion === undefined) continue;
		const oldestLive = await oldestWireVersionSince(db, service, now - WORKER_LIVE_WINDOW_MS);
		if (oldestLive !== null) {
			if (oldestLive < requiredWireVersion) {
				waits.push({
					service,
					requiredWireVersion,
					reason: 'lagging',
					oldestLiveWireVersion: oldestLive,
				});
			}
			continue;
		}
		const hasRecentReport =
			(await newestWireVersionSince(db, service, now - DEFAULT_WINDOW_DAYS * DAY_MS)) !== null;
		if (isServiceConfigured(service) || hasRecentReport) {
			waits.push({ service, requiredWireVersion, reason: 'missing', oldestLiveWireVersion: null });
		}
	}
	return waits;
}

// ── Retention ────────────────────────────────────────────────────────────────

/** Daily: drop reports not refreshed for {@link WORKER_SERVER_RETENTION_MS}. */
export const pruneStale = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const cutoff = Date.now() - WORKER_SERVER_RETENTION_MS;
		const stale = await ctx.db
			.query('workerServers')
			.withIndex('by_last_seen_at', (q) => q.lt('lastSeenAt', cutoff))
			.take(PRUNE_BATCH);
		for (const row of stale) await ctx.db.delete(row._id);
		if (stale.length === PRUNE_BATCH) {
			await ctx.scheduler.runAfter(0, internal.maintenance.workerRegistry.pruneStale, {});
		}
		return null;
	},
});
