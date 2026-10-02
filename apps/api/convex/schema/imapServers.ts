import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * What the IMAP servers report about themselves (ADR-0063): the release and
 * the wire contract version each one runs, so the backend can tell which old
 * IMAP servers are still in use before a compatibility path is removed.
 *
 * One row per host and build: a restart of the same container updates its row
 * (with the new process's `instanceId` and `startedAt`), so a crash-looping
 * container does not add a row per restart, while a host that ran two builds
 * keeps both until the older one ages out. Written by
 * `mail/imap/serverRegistry:report` at the server's startup and every few
 * minutes after; rows not seen for 30 days are pruned by a daily cron.
 *
 * IMAP servers that predate reporting (v0.6.7 and older) never write here.
 * Their logins are recorded as `legacyImapSeenAt` on the `imapLegacy` row of
 * `instanceCounters` instead.
 *
 * Deployment infrastructure state, not tenant data: no organization, no IPs.
 *
 * Spread into `defineSchema()` from schema.ts via `...imapServerTables`.
 */
export const imapServerTables = {
	imapServers: defineTable({
		/** Random per process; the process that reported last. */
		instanceId: v.string(),
		/** The container hostname (Docker: the container id), never an address. */
		hostLabel: v.string(),
		/** The image's `OWLAT_VERSION`; `dev` for an unreleased build. */
		owlatVersion: v.string(),
		/** `IMAP_WIRE_VERSION` of the reporting build (`@owlat/shared/imapWire`). */
		wireVersion: v.number(),
		/** When the reporting process started. */
		startedAt: v.number(),
		lastSeenAt: v.number(),
	})
		.index('by_host_and_build', ['hostLabel', 'owlatVersion', 'wireVersion'])
		.index('by_last_seen_at', ['lastSeenAt'])
		// The status summary: the lowest and highest wire version reported in a
		// window, probed per version rather than read off the capped list.
		.index('by_wire_version_and_last_seen_at', ['wireVersion', 'lastSeenAt']),
};
