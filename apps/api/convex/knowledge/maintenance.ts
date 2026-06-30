/**
 * Knowledge Graph Maintenance
 *
 * Scheduled maintenance tasks for the knowledge graph:
 * - Confidence decay (per-type rates)
 * - Expiration cleanup
 *
 * Decay rates by type:
 * - Fact: slow (0.5% per day, ~90 day half-life)
 * - Decision: very slow (0.2% per day)
 * - Event: none (historical records don't decay)
 * - Preference: medium (1.5% per day, ~30 day half-life)
 * - Goal: fast (3% per day, ~14 day half-life)
 * - Relationship: medium (1% per day)
 * - Action Item: fast (5% per day, ~7 day half-life)
 */

import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import {
	clusterBySimilarity,
	chooseSurvivor,
	mergeContent,
	unionDistinct,
	DEDUP_SIMILARITY_THRESHOLD,
} from '../lib/knowledgeDedup';
import { repointEdge } from './edges';

/** Decay rates per knowledge type (percentage per day) */
const DECAY_RATES: Record<string, number> = {
	fact: 0.005,
	decision: 0.002,
	event: 0, // Events don't decay
	preference: 0.015,
	goal: 0.03,
	relationship: 0.01,
	action_item: 0.05,
};

/** Minimum confidence before an entry is flagged for review */
const MIN_CONFIDENCE = 0.1;

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Usage-recency multiplier folded into the decay factor: a frequently-grounded
 * fact should fade slower than one that was once useful and has gone cold. Keyed
 * on `lastAccessedAt` (set by knowledge.retrieval on every recall). An entry
 * never recalled (undefined) stays neutral — we only act on *observed* usage, so
 * the access tracking can't retroactively punish entries created before it.
 *   - recalled within 7d  → 1.1 (slows decay; clamped so confidence never rises)
 *   - last recalled >30d   → 0.9 (fades faster)
 *   - in between / never   → 1.0 (unchanged)
 */
export function accessBoostFactor(lastAccessedAt: number | undefined, now: number): number {
	if (lastAccessedAt === undefined) return 1.0;
	const age = now - lastAccessedAt;
	if (age <= SEVEN_DAYS_MS) return 1.1;
	if (age > THIRTY_DAYS_MS) return 0.9;
	return 1.0;
}

/**
 * Run daily confidence decay on all knowledge entries
 */
export const runDecay = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const oneDayMs = 24 * 60 * 60 * 1000;

		// Process in batches to avoid timeout
		const entries = await ctx.db
			.query('knowledgeEntries')
			.order('asc')
			.take(200);

		let decayed = 0;
		let expired = 0;

		// Bound per-entry relation deletion so a hub node with thousands
		// of relations doesn't blow the mutation transaction budget. If
		// an entry has more relations than the cap, leftover rows are
		// picked up on the next run (the parent entry is only deleted
		// once both directions are drained).
		const RELATION_DELETE_CAP = 500;

		for (const entry of entries) {
			// ── Expiration check ──
			if (entry.expiresAt && entry.expiresAt < now) {
				const outgoing = await ctx.db
					.query('knowledgeRelations')
					.withIndex('by_from', (q) => q.eq('fromEntryId', entry._id))
					.take(RELATION_DELETE_CAP);
				const incoming = await ctx.db
					.query('knowledgeRelations')
					.withIndex('by_to', (q) => q.eq('toEntryId', entry._id))
					.take(RELATION_DELETE_CAP);
				for (const rel of [...outgoing, ...incoming]) {
					await ctx.db.delete(rel._id);
				}
				const drained =
					outgoing.length < RELATION_DELETE_CAP &&
					incoming.length < RELATION_DELETE_CAP;
				if (drained) {
					// Tear down the contact junction mirror before the entry so
					// no orphan knowledgeEntryContacts rows survive it.
					const links = await ctx.db
						.query('knowledgeEntryContacts')
						.withIndex('by_entry', (q) => q.eq('entryId', entry._id))
						.collect(); // bounded: one row per contact linked to a single entry (small)
					for (const link of links) {
						await ctx.db.delete(link._id);
					}
					await ctx.db.delete(entry._id);
					expired++;
				}
				continue;
			}

			// ── Confidence decay ──
			const decayRate = DECAY_RATES[entry.entryType] ?? 0;
			if (decayRate === 0) continue;

			const daysSinceValidation = (now - entry.lastValidatedAt) / oneDayMs;
			if (daysSinceValidation < 1) continue; // Don't decay entries validated today

			// Fold in the usage-recency boost, clamped at 1 so a hot entry decays
			// slower (down to not at all) but its confidence never inflates above
			// the stored value.
			const boost = accessBoostFactor(entry.lastAccessedAt, now);
			const decayFactor = Math.min(1, Math.pow(1 - decayRate, daysSinceValidation) * boost);
			const newConfidence = Math.max(entry.confidence * decayFactor, MIN_CONFIDENCE);

			if (Math.abs(newConfidence - entry.confidence) > 0.001) {
				await ctx.db.patch(entry._id, {
					confidence: newConfidence,
					updatedAt: now,
				});
				decayed++;
			}
		}

		return { decayed, expired, processed: entries.length };
	},
});

// Bound the pairwise comparison and per-merge relation rewrite so one
// pathological contact can't blow the transaction budget.
const DEDUP_MAX_ENTRIES_PER_CONTACT = 200;
const RELATION_REPOINT_CAP = 500;
const DEDUP_CONTACT_PAGE = 50;

/**
 * Merge a loser knowledge entry into the survivor, atomically: fold in content
 * (dedup), union contactIds + tags, repoint the contact junction and any
 * relations onto the survivor, then delete the loser. One Convex mutation, so a
 * crash can't leave a half-merge. Returns false (no-op) when relations exceed
 * the cap, leaving the loser for the next pass.
 */
async function mergeEntryInto(
	ctx: MutationCtx,
	survivor: Doc<'knowledgeEntries'>,
	loser: Doc<'knowledgeEntries'>,
	now: number,
): Promise<boolean> {
	const fromRels = await ctx.db
		.query('knowledgeRelations')
		.withIndex('by_from', (q) => q.eq('fromEntryId', loser._id))
		.take(RELATION_REPOINT_CAP);
	const toRels = await ctx.db
		.query('knowledgeRelations')
		.withIndex('by_to', (q) => q.eq('toEntryId', loser._id))
		.take(RELATION_REPOINT_CAP);
	if (fromRels.length >= RELATION_REPOINT_CAP || toRels.length >= RELATION_REPOINT_CAP) return false;

	// Survivor inherits the loser's content + scope + tags. Recompute
	// `searchableText` (the FTS searchField) so folded-in content stays findable,
	// and write the merged values back onto the in-memory survivor so a 3+-entry
	// cluster accumulates every loser instead of clobbering with only the last.
	const mergedContent = mergeContent(survivor.content, loser.content);
	const mergedContactIds = nonEmpty(unionDistinct(survivor.contactIds, loser.contactIds));
	const mergedTags = nonEmpty(unionDistinct(survivor.tags, loser.tags));
	await ctx.db.patch(survivor._id, {
		content: mergedContent,
		searchableText: `${survivor.title} ${mergedContent}`,
		contactIds: mergedContactIds,
		tags: mergedTags,
		updatedAt: now,
	});
	survivor.content = mergedContent;
	survivor.contactIds = mergedContactIds;
	survivor.tags = mergedTags;

	// Repoint the contact junction; drop a loser link the survivor already has.
	const survivorContacts = new Set(
		(
			await ctx.db
				.query('knowledgeEntryContacts')
				.withIndex('by_entry', (q) => q.eq('entryId', survivor._id))
				.collect() // bounded: junction rows for one entry (knowledge linked to a person)
		).map((l) => l.contactId as string),
	);
	const loserLinks = await ctx.db
		.query('knowledgeEntryContacts')
		.withIndex('by_entry', (q) => q.eq('entryId', loser._id))
		.collect(); // bounded: junction rows for one entry (knowledge linked to a person)
	for (const link of loserLinks) {
		if (survivorContacts.has(link.contactId as string)) {
			await ctx.db.delete(link._id);
		} else {
			await ctx.db.patch(link._id, { entryId: survivor._id });
			survivorContacts.add(link.contactId as string);
		}
	}

	// Repoint relations onto the survivor: collapse any parallel edge a blind
	// re-point would otherwise duplicate (shared by_pair merge via repointEdge)
	// and drop self-loops. Routes through the one edge-merge rule the construction
	// path uses instead of forking the dedup logic here.
	for (const rel of fromRels) {
		await repointEdge(ctx, rel, survivor._id, rel.toEntryId);
	}
	for (const rel of toRels) {
		await repointEdge(ctx, rel, rel.fromEntryId, survivor._id);
	}

	await ctx.db.delete(loser._id);
	return true;
}

function nonEmpty<T>(arr: T[]): T[] | undefined {
	return arr.length > 0 ? arr : undefined;
}

/**
 * Dedup-merge the knowledge entries linked to one contact. A backfilled mailbox
 * extracts the same fact many times with different titles; this collapses
 * near-identical embeddings (cosine >= threshold) into one entry. Idempotent and
 * convergent: the survivor is chosen deterministically, so re-runs are no-ops.
 */
export const dedupeContactEntries = internalMutation({
	args: {
		contactId: v.id('contacts'),
		threshold: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const threshold = args.threshold ?? DEDUP_SIMILARITY_THRESHOLD;
		const now = Date.now();

		const links = await ctx.db
			.query('knowledgeEntryContacts')
			.withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
			.take(DEDUP_MAX_ENTRIES_PER_CONTACT);
		if (links.length < 2) return { merged: 0 };

		const loaded = await Promise.all(links.map((l) => ctx.db.get(l.entryId)));
		// Only entries with a real embedding can be compared for similarity.
		const entries = loaded.filter(
			(e): e is Doc<'knowledgeEntries'> => e !== null && e.embedding.length > 0,
		);
		if (entries.length < 2) return { merged: 0 };

		const clusters = clusterBySimilarity(entries, (e) => e.embedding, threshold);

		let merged = 0;
		for (const cluster of clusters) {
			if (cluster.length < 2) continue;
			const survivor = chooseSurvivor(cluster.map((e) => ({ ...e, id: e._id as string })));
			const survivorDoc = cluster.find((e) => (e._id as string) === survivor.id)!;
			for (const loser of cluster) {
				if (loser._id === survivorDoc._id) continue;
				if (await mergeEntryInto(ctx, survivorDoc, loser, now)) merged++;
			}
		}
		return { merged };
	},
});

/**
 * Cron driver: page through contacts and schedule a per-contact dedup-merge for
 * each (own transaction per contact, so no single mutation does unbounded work).
 * Self-reschedules to the next page; the daily cron starts a fresh walk. Dedup
 * is idempotent, so re-walking is cheap once entries have converged.
 */
export const runKnowledgeDedup = internalMutation({
	args: {
		cursor: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const page = await ctx.db
			.query('contacts')
			.paginate({ cursor: args.cursor ?? null, numItems: DEDUP_CONTACT_PAGE });

		for (const contact of page.page) {
			await ctx.scheduler.runAfter(0, internal.knowledge.maintenance.dedupeContactEntries, {
				contactId: contact._id,
			});
		}

		if (!page.isDone) {
			await ctx.scheduler.runAfter(0, internal.knowledge.maintenance.runKnowledgeDedup, {
				cursor: page.continueCursor,
			});
		}
		return { scheduled: page.page.length, done: page.isDone };
	},
});
