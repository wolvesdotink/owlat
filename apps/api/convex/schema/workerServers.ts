import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * What every separately deployed worker reports about itself: the service, the
 * release and the wire contract version each process runs, so the backend can
 * show version skew and hold a contract step until every worker has moved
 * (`maintenance/workerRegistry.ts`).
 *
 * One row per service, host and build: a restart of the same container
 * updates its row (with the new process's `instanceId` and `startedAt`), so a
 * crash-looping container does not add a row per restart, while a host that
 * ran two builds keeps both until the older one ages out. Written at each
 * worker's startup and every 5 minutes after; rows not seen for 30 days are
 * pruned by a daily cron.
 *
 * The IMAP server's reports land here too. `imapServers` keeps its own copy:
 * that table holds the IMAP history from before this one existed, which
 * `mail/imap/serverRegistry:status` still reads as evidence for raising the
 * IMAP minimum.
 *
 * Deployment infrastructure state, not tenant data: no organization, no IPs.
 */
export const workerServerTables = {
	workerServers: defineTable({
		service: v.union(
			v.literal('imap'),
			v.literal('mail-sync'),
			v.literal('mta'),
			v.literal('code-worker')
		),
		/** Random per process; the process that reported last. */
		instanceId: v.string(),
		/** The container hostname (Docker: the container id), never an address. */
		hostLabel: v.string(),
		/** The image's `OWLAT_VERSION`; `dev` for an unreleased build. */
		owlatVersion: v.string(),
		/** The service's wire version in the reporting build (`@owlat/shared/workerWire`). */
		wireVersion: v.number(),
		/** When the reporting process started. */
		startedAt: v.number(),
		lastSeenAt: v.number(),
	})
		.index('by_service_and_host_and_build', ['service', 'hostLabel', 'owlatVersion', 'wireVersion'])
		.index('by_service_and_last_seen_at', ['service', 'lastSeenAt'])
		// The per-service summary: the lowest and highest wire version reported
		// in a window, probed per version rather than read off the capped list.
		.index('by_service_and_wire_version_and_last_seen_at', ['service', 'wireVersion', 'lastSeenAt'])
		.index('by_last_seen_at', ['lastSeenAt']),
};
