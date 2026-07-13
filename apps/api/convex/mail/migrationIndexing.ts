/**
 * Mailbox-migration AI indexing sweep.
 *
 * Phase 2 of a `mailboxMigrations` job: once the mail-sync worker has
 * backfilled a connected mailbox's history into Postbox (`mailMessages`), this
 * walks those messages and feeds each into the contact-scoped knowledge graph
 * via `knowledge.extraction.extractFromMailMessage`, so the AI assistant can
 * recall and learn from the user's imported correspondence.
 *
 * It deliberately mirrors `agent/knowledgeBackfill.ts` (the inbound-message
 * backfill): a self-rescheduling chunk runner with cursor pagination over a
 * stable, post-import message set, idempotent extraction, and paced LLM calls
 * so a large mailbox doesn't blow the model budget. The import phase finishes
 * before this starts, so the message set doesn't move under the cursor.
 *
 * No `'use node'` here — `extractFromMailMessage` is a Node action invoked via
 * `ctx.runAction` from this V8 action, the same supported boundary the inbound
 * backfill uses.
 *
 * This module owns the *indexing* phase of the migration lifecycle (the
 * `indexing → completed/failed` transitions + the `messagesIndexed` counter);
 * `mail/migration.ts` owns the *import* phase and hands off to here.
 */

import { v } from 'convex/values';
import { mailMessageInlineBody } from '../lib/messageBody';
import { takeReceivedAtChunk } from '../lib/receivedAtCursor';
import { internalAction, internalMutation, internalQuery } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { isFeatureEnabled } from '../lib/featureFlags';
import { resolveContact } from '../contacts/resolution';
import { markOnboardingStep } from '../auth/userOnboarding';
import { normalizeEmail } from '@owlat/shared';

// Tunables — kept in step with agent/knowledgeBackfill.ts.
const INTER_MESSAGE_DELAY_MS = 150;
const INTER_CHUNK_DELAY_MS = 1500;

// ============================================================
// Internal queries
// ============================================================

/** Load a migration row (chunk runner state). */
export const loadMigration = internalQuery({
	args: { migrationId: v.id('mailboxMigrations') },
	handler: async (ctx, args) => ctx.db.get(args.migrationId),
});

/** True iff the `ai.knowledge` feature flag is on. Honors mid-sweep disable. */
export const isKnowledgeEnabled = internalQuery({
	args: {},
	handler: async (ctx) => isFeatureEnabled(ctx, 'ai.knowledge'),
});

/**
 * Sender/subject/body of one imported message, for `extractFromMailMessage`.
 * Returns the inline body and/or the storage ref (the action resolves large
 * bodies from storage itself — queries can't read blob contents).
 */
export const getMessageForExtraction = internalQuery({
	args: { mailMessageId: v.id('mailMessages') },
	handler: async (ctx, args) => {
		const m = await ctx.db.get(args.mailMessageId);
		if (!m) return null;
		return {
			fromAddress: m.fromAddress,
			fromName: m.fromName,
			subject: m.subject,
			textInline: mailMessageInlineBody(m).text,
			textStorageId: m.textBodyStorageId,
			htmlInline: mailMessageInlineBody(m).html,
		};
	},
});

/**
 * Page of `mailMessages` for a mailbox strictly after the cursor, ordered by
 * `(receivedAt asc, _id asc)`. The cursor is the last processed message's
 * `(receivedAt, _id)`; on the first page both are undefined.
 *
 * Same-timestamp groups are drained exactly — see lib/receivedAtCursor.ts
 * for the rationale (this walker and knowledgeBackfill share it).
 */
export const nextIndexChunk = internalQuery({
	args: {
		mailboxId: v.id('mailboxes'),
		cursorReceivedAt: v.optional(v.number()),
		cursorId: v.optional(v.id('mailMessages')),
		limit: v.number(),
	},
	handler: async (ctx, args) => {
		const { mailboxId, limit, cursorReceivedAt, cursorId } = args;
		const toLite = (m: Doc<'mailMessages'>) => ({
			_id: m._id,
			receivedAt: m.receivedAt,
			fromAddress: m.fromAddress,
			fromName: m.fromName,
		});

		const page = await takeReceivedAtChunk<Doc<'mailMessages'>>({
			limit,
			cursorReceivedAt,
			cursorId,
			firstPage: (take) =>
				ctx.db
					.query('mailMessages')
					.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', mailboxId))
					.order('asc')
					.take(take),
			sameTimestamp: (receivedAt) =>
				ctx.db
					.query('mailMessages')
					.withIndex('by_mailbox_and_received', (q) =>
						q.eq('mailboxId', mailboxId).eq('receivedAt', receivedAt)
					)
					.collect(), // bounded: messages sharing one exact-millisecond receivedAt
			newer: (receivedAt, take) =>
				ctx.db
					.query('mailMessages')
					.withIndex('by_mailbox_and_received', (q) =>
						q.eq('mailboxId', mailboxId).gt('receivedAt', receivedAt)
					)
					.order('asc')
					.take(take),
		});
		return { messages: page.rows.map(toLite), hasMore: page.hasMore };
	},
});

// ============================================================
// Internal mutations
// ============================================================

/**
 * Find-or-create the CRM contact for an imported message's sender, so the
 * extracted knowledge is scoped to that person (the same isolation model the
 * agent uses). Uses the quiet `resolveContact` core (NOT `createContact`) so
 * importing history never fires automation triggers. `upsert` mode means we
 * create missing senders but never overwrite a user-curated contact's name.
 * Returns null when the address is unusable (knowledge then lands org-general).
 */
export const resolveSenderContact = internalMutation({
	args: { email: v.string(), fromName: v.optional(v.string()) },
	handler: async (ctx, args): Promise<{ contactId: Id<'contacts'> | null }> => {
		const email = normalizeEmail(args.email);
		if (!email.includes('@')) return { contactId: null };
		const { firstName, lastName } = splitDisplayName(args.fromName);
		const { contactId } = await resolveContact(ctx, {
			channel: 'email',
			identifier: email,
			source: 'import',
			mode: 'upsert',
			contactFields: { firstName, lastName },
		});
		return { contactId };
	},
});

/** Split an RFC 5322 display name into first/last for new contacts. */
function splitDisplayName(name: string | undefined): {
	firstName?: string;
	lastName?: string;
} {
	const trimmed = name?.trim();
	if (!trimmed) return {};
	const parts = trimmed.split(/\s+/);
	if (parts.length === 1) return { firstName: parts[0] };
	return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

/** Advance the index cursor and bump the swept-message counter. */
export const patchIndexProgress = internalMutation({
	args: {
		migrationId: v.id('mailboxMigrations'),
		deltaIndexed: v.number(),
		cursorReceivedAt: v.optional(v.number()),
		cursorId: v.optional(v.id('mailMessages')),
	},
	handler: async (ctx, args) => {
		const migration = await ctx.db.get(args.migrationId);
		// Only touch a still-indexing row: a chunk that was in flight when the
		// user cancelled (status → 'cancelled') must not resurrect the counter.
		if (!migration || migration.status !== 'indexing') return;
		await ctx.db.patch(args.migrationId, {
			messagesIndexed: migration.messagesIndexed + args.deltaIndexed,
			indexCursorReceivedAt: args.cursorReceivedAt ?? migration.indexCursorReceivedAt,
			indexCursorId: args.cursorId ?? migration.indexCursorId,
			updatedAt: Date.now(),
		});
	},
});

/** Move the migration to a terminal state. */
export const finalizeMigration = internalMutation({
	args: {
		migrationId: v.id('mailboxMigrations'),
		status: v.union(v.literal('completed'), v.literal('failed'), v.literal('cancelled')),
		errorMessage: v.optional(v.string()),
		// True ONLY when the sweep reached its natural end (`!hasMore`). The
		// feature-disable branch also finalizes with status 'completed' but passes
		// false, so a cut-off sweep never counts as knowledge indexed.
		indexingRanToCompletion: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		const migration = await ctx.db.get(args.migrationId);
		// Don't transition a row that already left the indexing phase. The chunk
		// runner can race a user Cancel (which patches status → 'cancelled' while
		// a chunk is in flight); without this guard the final chunk would overwrite
		// the cancellation back to 'completed' and silently undo the user's intent.
		if (!migration || migration.status !== 'indexing') return;
		const now = Date.now();
		await ctx.db.patch(args.migrationId, {
			status: args.status,
			completedAt: now,
			updatedAt: now,
			lastError: args.errorMessage ?? migration.lastError,
		});
		// Only a sweep that ran to its natural end counts as knowledge indexed for
		// the migration owner's onboarding checklist — a mid-sweep feature disable
		// finalizes with status 'completed' too, but leaves the step unmarked.
		if (args.status === 'completed' && args.indexingRanToCompletion === true) {
			await markOnboardingStep(ctx, migration.userId, 'knowledgeIndexed');
		}
	},
});

// ============================================================
// Internal action — the chunk workhorse
// ============================================================

/**
 * Process one chunk of imported messages through `extractFromMailMessage`,
 * advance the cursor, and either reschedule for the next chunk or finalize the
 * migration as `completed`. Scheduled by `mail/migration.completeBackfillImport`
 * once the import phase is done.
 */
export const runIndexChunk = internalAction({
	args: {
		migrationId: v.id('mailboxMigrations'),
		chunkSize: v.number(),
		// Tests pass 0 so `finishInProgressScheduledFunctions` drains the chain
		// without real-time waits (mirrors knowledgeBackfill.runChunk).
		interChunkDelayMs: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const interChunkDelay = args.interChunkDelayMs ?? INTER_CHUNK_DELAY_MS;
		try {
			const migration = await ctx.runQuery(internal.mail.migrationIndexing.loadMigration, {
				migrationId: args.migrationId,
			});
			if (!migration) return;
			if (migration.status !== 'indexing') return; // cancelled / already done

			// Honor a mid-sweep feature disable: the import is kept, indexing stops.
			const enabled = await ctx.runQuery(internal.mail.migrationIndexing.isKnowledgeEnabled, {});
			if (!enabled) {
				await ctx.runMutation(internal.mail.migrationIndexing.finalizeMigration, {
					migrationId: args.migrationId,
					status: 'completed',
					// Sweep cut off mid-flight — import kept, but knowledge is incomplete.
					indexingRanToCompletion: false,
				});
				return;
			}

			const { messages, hasMore } = await ctx.runQuery(
				internal.mail.migrationIndexing.nextIndexChunk,
				{
					mailboxId: migration.mailboxId,
					cursorReceivedAt: migration.indexCursorReceivedAt,
					cursorId: migration.indexCursorId,
					limit: args.chunkSize,
				}
			);

			let deltaIndexed = 0;
			let lastReceivedAt: number | undefined;
			let lastId: Id<'mailMessages'> | undefined;

			for (const msg of messages) {
				deltaIndexed++;
				lastReceivedAt = msg.receivedAt;
				lastId = msg._id;

				// Idempotency: a message already swept (migration restart / retry)
				// is counted but not re-extracted — saves the runAction round-trip
				// and a redundant LLM call.
				const already = await ctx.runQuery(internal.knowledge.graph.countBySource, {
					sourceType: 'email',
					sourceId: msg._id,
				});
				if (already > 0) continue;

				// Scope the knowledge to the sender (quiet find-or-create).
				const { contactId } = await ctx.runMutation(
					internal.mail.migrationIndexing.resolveSenderContact,
					{ email: msg.fromAddress, fromName: msg.fromName ?? undefined }
				);

				// An unresolvable sender (e.g. a malformed From header) would
				// otherwise land org-general — visible in every contact's retrieval.
				// The migration only imports contact-scoped knowledge; the message
				// is still counted (deltaIndexed above) and the cursor advances.
				if (!contactId) continue;

				try {
					await ctx.runAction(internal.knowledge.extraction.extractFromMailMessage, {
						mailMessageId: msg._id,
						contactIds: [contactId],
					});
				} catch (err) {
					// eslint-disable-next-line no-console
					console.error('[mailMigration] extraction error', err);
				}

				// Light pacing between LLM calls.
				if (INTER_MESSAGE_DELAY_MS > 0) {
					await new Promise((r) => setTimeout(r, INTER_MESSAGE_DELAY_MS));
				}
			}

			await ctx.runMutation(internal.mail.migrationIndexing.patchIndexProgress, {
				migrationId: args.migrationId,
				deltaIndexed,
				cursorReceivedAt: lastReceivedAt,
				cursorId: lastId,
			});

			if (hasMore) {
				await ctx.scheduler.runAfter(
					interChunkDelay,
					internal.mail.migrationIndexing.runIndexChunk,
					{
						migrationId: args.migrationId,
						chunkSize: args.chunkSize,
						interChunkDelayMs: args.interChunkDelayMs,
					}
				);
			} else {
				await ctx.runMutation(internal.mail.migrationIndexing.finalizeMigration, {
					migrationId: args.migrationId,
					status: 'completed',
					indexingRanToCompletion: true,
				});
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			// eslint-disable-next-line no-console
			console.error('[mailMigration] runIndexChunk failed', err);
			try {
				await ctx.runMutation(internal.mail.migrationIndexing.finalizeMigration, {
					migrationId: args.migrationId,
					status: 'failed',
					errorMessage: message,
				});
			} catch {
				// finalize best-effort
			}
		}
	},
});
