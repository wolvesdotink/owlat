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
 * their logins instead: `mail/appPasswords.touch` without `imapWireVersion`
 * calls {@link noteLegacyImapLogin}.
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
	/** The last login through a pre-reporting IMAP server, any time; null if none recorded. */
	legacyImapSeenAt: number | null;
	isLegacyInWindow: boolean;
	/** The lowest wire version seen in the window, legacy counting as 0; null if nothing reported. */
	oldestWireVersionSeen: number | null;
	/**
	 * The highest `IMAP_WIRE_MIN_SUPPORTED` that would refuse no IMAP server seen
	 * in the window. Evidence for this deployment only: a release that raises
	 * the minimum still has to respect the skew policy for every deployment.
	 */
	safeToRaiseMinTo: number;
}

export async function readImapServerStatus(
	db: DatabaseReader,
	now: number,
	days: number = DEFAULT_WINDOW_DAYS
): Promise<ImapServerStatus> {
	const windowDays = Math.min(Math.max(Math.floor(days), 1), MAX_WINDOW_DAYS);
	const since = now - windowDays * DAY_MS;
	const rows = await db
		.query('imapServers')
		.withIndex('by_last_seen_at', (q) => q.gte('lastSeenAt', since))
		.order('desc')
		.take(MAX_LISTED_SERVERS);
	const servers = rows.map((row) => ({
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

	const wireVersions = servers.map((s) => s.wireVersion);
	if (isLegacyInWindow) wireVersions.push(IMAP_WIRE_LEGACY);
	const oldestWireVersionSeen = wireVersions.length > 0 ? Math.min(...wireVersions) : null;

	return {
		backendWireVersion: IMAP_WIRE_VERSION,
		minSupportedWireVersion: IMAP_WIRE_MIN_SUPPORTED,
		windowDays,
		servers,
		legacyImapSeenAt: legacyImapSeenAt ?? null,
		isLegacyInWindow,
		oldestWireVersionSeen,
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
