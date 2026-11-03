import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Brand logos of authenticated senders, one row per organisational domain
 * (`mail/senderLogos/`). Filled server-side, so a client never contacts the
 * sender's domain to draw an avatar.
 *
 * Instance-wide and free of message data: a row says which logo a domain
 * publishes, not who received mail from it. It is still tenant data for the
 * wipe (the set of domains is a trace of who wrote to the workspace), and the
 * deletion step frees the stored image with the row.
 */
export const senderLogosTables = {
	senderLogos: defineTable({
		/** Organisational domain, lowercase (`@owlat/shared/dnsZone` organizationalDomain). */
		domain: v.string(),
		/**
		 * `pending` until the first lookup finishes, then `found` with a stored
		 * image or `none` when the domain publishes nothing usable. A refresh
		 * keeps the status and only moves `requestedAt`.
		 */
		status: v.union(v.literal('pending'), v.literal('found'), v.literal('none')),
		/** Where the image came from: a BIMI record, or the site's own icon. */
		source: v.optional(v.union(v.literal('bimi'), v.literal('icon'))),
		storageId: v.optional(v.id('_storage')),
		/** When the newest lookup was scheduled; one that never finished is retried. */
		requestedAt: v.number(),
		/** When the last lookup finished. Absent until one has. */
		checkedAt: v.optional(v.number()),
	}).index('by_domain', ['domain']),
};
