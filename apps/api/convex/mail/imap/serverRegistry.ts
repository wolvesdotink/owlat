/**
 * The IMAP server registry (ADR-0063): which IMAP server releases are calling
 * this backend, and whether the backend still serves their wire contract.
 *
 * - `report`: the IMAP server's handshake, once before it starts listening and
 *   every few minutes after. The answer tells it whether to serve, wait for a
 *   backend update, or refuse to start.
 * - `status`: the operator's evidence before a compatibility path is removed,
 *   `npx convex run mail/imap/serverRegistry:status '{"days": 7}'`.
 * - `getForAdmin`: the same summary for Settings → System & updates.
 * - `pruneStale`: the daily cron that drops reports older than 30 days.
 *
 * IMAP servers from before reporting (v0.6.7 and older) are noticed through
 * their logins instead: `mail/appPasswords.verify` refuses an IMAP login
 * without `imapWireVersion` and calls {@link noteLegacyLogin} first, and
 * `mail/appPasswords.touch` without one calls {@link noteLegacyImapLogin}.
 */

import { v } from 'convex/values';
import {
	IMAP_WIRE_LEGACY,
	IMAP_WIRE_MIN_SUPPORTED,
	IMAP_WIRE_VERSION,
	imapWireVerdict,
	type ImapWireVerdict,
} from '@owlat/shared/imapWire';
import { internalQuery, type DatabaseReader, type MutationCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { internalMutation } from '../../lib/writeFence';
import { platformAdminQuery } from '../../lib/authedFunctions';
import { DAY_MS, HOUR_MS } from '../../lib/constants';
import { readInstanceCounter, writeInstanceCounter } from '../../lib/instanceCounters';
import { throwInvalidState } from '../../_utils/errors';

/** Reports not refreshed for this long are deleted. */
export const IMAP_SERVER_RETENTION_MS = 30 * DAY_MS;

/** A legacy login is recorded at most once per this interval. */
export const LEGACY_IMAP_WRITE_INTERVAL_MS = HOUR_MS;

/** The default status window, and its bounds. */
const DEFAULT_WINDOW_DAYS = 7;
const MAX_WINDOW_DAYS = 30;

/** Upper bound on rows a status read returns (one per host and build). */
const MAX_LISTED_SERVERS = 200;

const PRUNE_BATCH = 200;

/** Reported strings are labels, not data: clamp them. */
const MAX_LABEL_LENGTH = 64;

const clampLabel = (value: string, fallback: string) =>
	value.trim().slice(0, MAX_LABEL_LENGTH) || fallback;

const verdictOf = (wireVersion: number): ImapWireVerdict =>
	imapWireVerdict(wireVersion, IMAP_WIRE_VERSION, IMAP_WIRE_MIN_SUPPORTED);

type ReportResult = {
	backendWireVersion: number;
	minSupportedWireVersion: number;
	compatible: boolean;
	reason?: 'server_too_old' | 'backend_older';
};

/**
 * Refuse a call from an IMAP server older than `IMAP_WIRE_MIN_SUPPORTED`. A
 * caller that sends no `imapWireVersion` is one from before reporting (legacy,
 * wire 0). A no-op while the minimum is 0.
 *
 * The handshake only stops servers that report, and a running one only at its
 * next report. So a function whose contract a later PR contracts takes an
 * optional `imapWireVersion` one release ahead, and the contracting PR calls
 * this at the top of it, before any side effect (CONVENTIONS.md, "IMAP wire
 * version"; ADR-0063). `mail/appPasswords:verify` calls it for IMAP logins.
 */
export function assertImapWireSupported(imapWireVersion: number | undefined): void {
	const wireVersion = imapWireVersion ?? IMAP_WIRE_LEGACY;
	if (wireVersion >= IMAP_WIRE_MIN_SUPPORTED) return;
	throwInvalidState(
		`This IMAP server speaks wire version ${wireVersion}; the backend serves ` +
			`${IMAP_WIRE_MIN_SUPPORTED} and newer. Update the IMAP container.`,
		{ imapWireVersion: wireVersion, minSupportedWireVersion: IMAP_WIRE_MIN_SUPPORTED }
	);
}

/**
 * Record that a login went through an IMAP server too old to report its
 * version. Written at most hourly so logins never contend on the row.
 */
export async function noteLegacyImapLogin(
	ctx: MutationCtx,
	now: number = Date.now()
): Promise<void> {
	const { legacyImapSeenAt } = await readInstanceCounter(ctx.db, 'imapLegacy');
	if (legacyImapSeenAt !== undefined && now - legacyImapSeenAt < LEGACY_IMAP_WRITE_INTERVAL_MS) {
		return;
	}
	await writeInstanceCounter(ctx, 'imapLegacy', { legacyImapSeenAt: now }, now);
}

/**
 * {@link noteLegacyImapLogin} for `mail/appPasswords:verify`, an action. Since
 * the backend stopped serving wire 0, a pre-reporting IMAP server's logins are
 * refused there and never reach `touch`; this keeps them on the status page.
 */
export const noteLegacyLogin = internalMutation({
	args: {},
	handler: async (ctx) => {
		await noteLegacyImapLogin(ctx);
	},
});

export const report = internalMutation({
	args: {
		instanceId: v.string(),
		hostLabel: v.string(),
		owlatVersion: v.string(),
		wireVersion: v.number(),
		startedAt: v.number(),
	},
	handler: async (ctx, args): Promise<ReportResult> => {
		const now = Date.now();
		const hostLabel = clampLabel(args.hostLabel, 'unknown');
		const owlatVersion = clampLabel(args.owlatVersion, 'dev');
		const fields = {
			instanceId: clampLabel(args.instanceId, 'unknown'),
			startedAt: args.startedAt,
			lastSeenAt: now,
		};
		const existing = await ctx.db
			.query('imapServers')
			.withIndex('by_host_and_build', (q) =>
				q
					.eq('hostLabel', hostLabel)
					.eq('owlatVersion', owlatVersion)
					.eq('wireVersion', args.wireVersion)
			)
			.first(); // bounded: one row per host and build
		if (existing) await ctx.db.patch(existing._id, fields);
		else {
			await ctx.db.insert('imapServers', {
				...fields,
				hostLabel,
				owlatVersion,
				wireVersion: args.wireVersion,
			});
		}

		const verdict = verdictOf(args.wireVersion);
		const result: ReportResult = {
			backendWireVersion: IMAP_WIRE_VERSION,
			minSupportedWireVersion: IMAP_WIRE_MIN_SUPPORTED,
			compatible: verdict === 'current' || verdict === 'supported',
		};
		if (verdict === 'unsupported') result.reason = 'server_too_old';
		if (verdict === 'ahead') result.reason = 'backend_older';
		return result;
	},
});

export interface ImapServerStatus {
	backendWireVersion: number;
	minSupportedWireVersion: number;
	windowDays: number;
	servers: Array<{
		instanceId: string;
		hostLabel: string;
		owlatVersion: string;
		wireVersion: number;
		startedAt: number;
		lastSeenAt: number;
		verdict: ImapWireVerdict;
	}>;
	/** `servers` holds the most recent rows only; the summary fields cover every row. */
	isListTruncated: boolean;
	/** The last login through a pre-reporting IMAP server, any time; null if none recorded. */
	legacyImapSeenAt: number | null;
	isLegacyInWindow: boolean;
	/** The lowest wire version seen in the window, legacy counting as 0; null if nothing reported. */
	oldestWireVersionSeen: number | null;
	/** The highest wire version reported in the window; null if nothing reported. */
	newestWireVersionSeen: number | null;
	/**
	 * The highest `IMAP_WIRE_MIN_SUPPORTED` that would refuse no IMAP server seen
	 * in the window. Evidence for this deployment only: a release that raises
	 * the minimum still has to respect the skew policy for every deployment.
	 */
	safeToRaiseMinTo: number;
}

/**
 * Distinct wire versions probed before giving up. Rows live at most 30 days and
 * a release bumps the version at most once, so a handful exist in practice.
 */
const MAX_WIRE_PROBES = 32;

const WIRE_INDEX = 'by_wire_version_and_last_seen_at';

/**
 * The lowest wire version any server reported since `since`, over every row,
 * not just the listed ones: per distinct version, one read finds the version
 * and one checks it for a report inside the window. Past the probe budget it
 * answers legacy, which permits raising nothing.
 */
async function oldestReportedWireVersion(
	db: DatabaseReader,
	since: number
): Promise<number | null> {
	let after: number | undefined;
	for (let probe = 0; probe < MAX_WIRE_PROBES; probe++) {
		const floor = after;
		const next = await (
			floor === undefined
				? db.query('imapServers').withIndex(WIRE_INDEX)
				: db.query('imapServers').withIndex(WIRE_INDEX, (q) => q.gt('wireVersion', floor))
		).first();
		if (!next) return null;
		const inWindow = await db
			.query('imapServers')
			.withIndex(WIRE_INDEX, (q) => q.eq('wireVersion', next.wireVersion).gte('lastSeenAt', since))
			.first();
		if (inWindow) return next.wireVersion;
		after = next.wireVersion;
	}
	return IMAP_WIRE_LEGACY;
}

/**
 * The highest wire version any server reported since `since`. Walking down,
 * each version's first row is its latest report, so one read per version.
 */
async function newestReportedWireVersion(
	db: DatabaseReader,
	since: number
): Promise<number | null> {
	let below: number | undefined;
	for (let probe = 0; probe < MAX_WIRE_PROBES; probe++) {
		const ceiling = below;
		const next = await (
			ceiling === undefined
				? db.query('imapServers').withIndex(WIRE_INDEX)
				: db.query('imapServers').withIndex(WIRE_INDEX, (q) => q.lt('wireVersion', ceiling))
		)
			.order('desc')
			.first();
		if (!next) return null;
		if (next.lastSeenAt >= since) return next.wireVersion;
		below = next.wireVersion;
	}
	return null;
}

export async function readImapServerStatus(
	db: DatabaseReader,
	now: number,
	days: number = DEFAULT_WINDOW_DAYS
): Promise<ImapServerStatus> {
	const windowDays = Math.min(Math.max(Math.floor(days), 1), MAX_WINDOW_DAYS);
	const since = now - windowDays * DAY_MS;
	// The list is for display and is capped; the summary below is not derived
	// from it.
	const rows = await db
		.query('imapServers')
		.withIndex('by_last_seen_at', (q) => q.gte('lastSeenAt', since))
		.order('desc')
		.take(MAX_LISTED_SERVERS + 1);
	const servers = rows.slice(0, MAX_LISTED_SERVERS).map((row) => ({
		instanceId: row.instanceId,
		hostLabel: row.hostLabel,
		owlatVersion: row.owlatVersion,
		wireVersion: row.wireVersion,
		startedAt: row.startedAt,
		lastSeenAt: row.lastSeenAt,
		verdict: verdictOf(row.wireVersion),
	}));

	const { legacyImapSeenAt } = await readInstanceCounter(db, 'imapLegacy');
	const isLegacyInWindow = legacyImapSeenAt !== undefined && legacyImapSeenAt >= since;

	const oldestReported = await oldestReportedWireVersion(db, since);
	const wireVersions = oldestReported === null ? [] : [oldestReported];
	if (isLegacyInWindow) wireVersions.push(IMAP_WIRE_LEGACY);
	const oldestWireVersionSeen = wireVersions.length > 0 ? Math.min(...wireVersions) : null;

	return {
		backendWireVersion: IMAP_WIRE_VERSION,
		minSupportedWireVersion: IMAP_WIRE_MIN_SUPPORTED,
		windowDays,
		servers,
		isListTruncated: rows.length > MAX_LISTED_SERVERS,
		legacyImapSeenAt: legacyImapSeenAt ?? null,
		isLegacyInWindow,
		oldestWireVersionSeen,
		newestWireVersionSeen: await newestReportedWireVersion(db, since),
		safeToRaiseMinTo:
			oldestWireVersionSeen === null
				? IMAP_WIRE_VERSION
				: Math.min(oldestWireVersionSeen, IMAP_WIRE_VERSION),
	};
}

/** Operator status: `npx convex run mail/imap/serverRegistry:status '{"days": 7}'`. */
export const status = internalQuery({
	args: { days: v.optional(v.number()) },
	handler: async (ctx, args): Promise<ImapServerStatus> =>
		readImapServerStatus(ctx.db, Date.now(), args.days),
});

/** The last 7 days for Settings → System & updates. */
export const getForAdmin = platformAdminQuery({
	args: {},
	handler: async (ctx): Promise<ImapServerStatus> => readImapServerStatus(ctx.db, Date.now()),
});

/** Daily: drop reports not refreshed for {@link IMAP_SERVER_RETENTION_MS}. */
export const pruneStale = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const cutoff = Date.now() - IMAP_SERVER_RETENTION_MS;
		const stale = await ctx.db
			.query('imapServers')
			.withIndex('by_last_seen_at', (q) => q.lt('lastSeenAt', cutoff))
			.take(PRUNE_BATCH);
		for (const row of stale) await ctx.db.delete(row._id);
		if (stale.length === PRUNE_BATCH) {
			await ctx.scheduler.runAfter(0, internal.mail.imap.serverRegistry.pruneStale, {});
		}
		return null;
	},
});
