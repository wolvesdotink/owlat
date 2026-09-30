/**
 * Mailbox-migration AI indexing sweep.
 *
 * Phase 2 of a `mailboxMigrations` job: once the mail-sync worker has
 * backfilled a connected mailbox's history into Postbox (`mailMessages`), this
 * walks those messages and feeds each into the contact-scoped knowledge graph
 * via `knowledge.extraction.extractFromMailMessage`, so the AI assistant can
 * recall and learn from the user's imported correspondence.
 *
 * It deliberately mirrors `knowledge/messageBackfill.ts` (the inbound-message
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
import { openStoredInlineBody } from '../lib/messageBodyStore';
import { takeReceivedAtChunk } from '../lib/receivedAtCursor';
import {
	internalAction,
	internalQuery,
	type ActionCtx,
	type MutationCtx,
} from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { isFeatureEnabled } from '../lib/featureFlags';
import { resolveContact } from '../contacts/resolution';
import { markOnboardingStep } from '../auth/userOnboarding';
import { normalizeEmail } from '@owlat/shared';
import { logError } from '../lib/runtimeLog';
import { loadExtractableMail } from './knowledgeScreen';

// Tunables. Pacing comes from the concurrency cap: at most this many
// extractions (LLM calls) in flight per sweep.
/** Chunk size for the knowledge sweep. Lives here, not with the import that
 * hands off to it, so this module imports nothing from the migration
 * lifecycle modules that call into it. */
export const INDEX_CHUNK_SIZE = 25;
const INTER_CHUNK_DELAY_MS = 1500;
const INDEX_CONCURRENCY = 4;
/** Stop taking new messages after this long; well inside the 600s action limit
 *  plus one extraction's own LLM deadline (knowledge/extraction.ts). */
const CHUNK_TIME_BUDGET_MS = 4 * 60 * 1000;

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
 * Sender/subject/body of one imported message, for `extractFromMailMessage`,
 * plus the trust signals `mail/knowledgeScreen.ts` screens it on.
 * Returns the inline body and/or the storage ref (the action resolves large
 * bodies from storage itself — queries can't read blob contents).
 */
export const getMessageForExtraction = internalQuery({
	args: { mailMessageId: v.id('mailMessages') },
	handler: async (ctx, args) => {
		const m = await ctx.db.get(args.mailMessageId);
		if (!m) return null;
		const { text, html } = await openStoredInlineBody(ctx.db, m);
		return {
			fromAddress: m.fromAddress,
			fromName: m.fromName,
			replyToAddress: m.replyToAddress,
			subject: m.subject,
			spamVerdict: m.spamVerdict,
			dmarcResult: m.dmarcResult,
			dmarcOverride: m.dmarcOverride,
			senderHeuristics: m.senderHeuristics,
			textInline: text,
			textStorageId: m.textBodyStorageId,
			htmlInline: html,
		};
	},
});

/**
 * Page of `mailMessages` for a mailbox strictly after the cursor, ordered by
 * `(receivedAt asc, _id asc)`. The cursor is the last processed message's
 * `(receivedAt, _id)`; on the first page both are undefined.
 *
 * Same-timestamp groups are drained exactly — see lib/receivedAtCursor.ts
 * for the rationale (this walker and knowledge/messageBackfill share it).
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

/** Why {@link startReindexSweep} did not start a sweep. */
export type ReindexRefusal =
	| 'not_found'
	| 'ai_knowledge_disabled'
	| `status_${Doc<'mailboxMigrations'>['status']}`;

/**
 * Re-run a finished import's indexing sweep over its mailbox.
 *
 * For an import that finished WITHOUT knowledge — opted out, imported while
 * `ai.knowledge` was off, or swept while the embedder could not store a
 * vector — which otherwise has no way back short of re-importing the whole
 * mailbox. The sweep starts from the first message; messages that already
 * produced entries are counted, not re-extracted.
 *
 * Plain helper, not a Convex function: each caller owns its own authorization
 * (the operator entry point below; the owner-gated `learnFromImport` /
 * `learnFromImportShared` behind the wizard and the team-inbox card).
 */
export async function startReindexSweep(
	ctx: MutationCtx,
	migration: Doc<'mailboxMigrations'> | null
): Promise<{ started: true } | { started: false; reason: ReindexRefusal }> {
	if (!migration) return { started: false, reason: 'not_found' };
	// Only a completed import has a settled message set to walk; a running
	// one hands off to indexing by itself.
	if (migration.status !== 'completed') {
		return { started: false, reason: `status_${migration.status}` };
	}
	if (!(await isFeatureEnabled(ctx, 'ai.knowledge'))) {
		return { started: false, reason: 'ai_knowledge_disabled' };
	}
	const now = Date.now();
	await ctx.db.patch(migration._id, {
		status: 'indexing',
		isAiIndexingEnabled: true,
		messagesIndexed: 0,
		indexCursorReceivedAt: undefined,
		indexCursorId: undefined,
		completedAt: undefined,
		updatedAt: now,
	});
	await ctx.db.insert('mailAuditLog', {
		mailboxId: migration.mailboxId,
		event: 'migration.reindex_started',
		details: `migration=${migration._id}`,
		occurredAt: now,
	});
	await ctx.scheduler.runAfter(0, internal.mail.migrationIndexing.runIndexChunk, {
		migrationId: migration._id,
		chunkSize: INDEX_CHUNK_SIZE,
	});
	return { started: true };
}

/**
 * Operator entry point for {@link startReindexSweep}
 * (`migrations/0050_reindex_mailbox_knowledge`), keyed by migration id.
 */
export const reindexMigration = internalMutation({
	args: { migrationId: v.id('mailboxMigrations') },
	handler: async (ctx, args): Promise<{ started: boolean; reason?: string }> =>
		await startReindexSweep(ctx, await ctx.db.get(args.migrationId)),
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
		// finalizes with status 'completed' too, but leaves the step unmarked. A
		// `shared` migration indexed a TEAM inbox (org infrastructure, opt-in), so
		// it never counts toward the admin's personal checklist either.
		if (
			args.status === 'completed' &&
			args.indexingRanToCompletion === true &&
			migration.scope !== 'shared'
		) {
			await markOnboardingStep(ctx, migration.userId, 'knowledgeIndexed');
		}
	},
});

// ============================================================
// Internal action — the chunk workhorse
// ============================================================

/**
 * Extract one imported message into the knowledge graph, scoped to its
 * sender's contact. Never throws: one message failing must not abort the chunk.
 */
async function indexOneMessage(
	ctx: ActionCtx,
	migrationId: Id<'mailboxMigrations'>,
	msg: { _id: Id<'mailMessages'>; fromAddress: string; fromName?: string }
): Promise<void> {
	try {
		// Idempotency: a message already swept (migration restart / retry) is
		// counted but not re-extracted — saves a redundant LLM call.
		const already = await ctx.runQuery(internal.knowledge.graph.countBySource, {
			sourceType: 'email',
			sourceId: msg._id,
		});
		if (already > 0) return;

		// Phishing and spoofed mail never feeds the graph (and its sender never
		// becomes a contact). Still counted; the cursor advances.
		if (!(await loadExtractableMail(ctx, msg._id))) return;

		// Scope the knowledge to the sender (quiet find-or-create).
		const { contactId } = await ctx.runMutation(
			internal.mail.migrationIndexing.resolveSenderContact,
			{ email: msg.fromAddress, fromName: msg.fromName ?? undefined }
		);
		// An unresolvable sender (e.g. a malformed From header) would otherwise
		// land org-general — visible in every contact's retrieval. The migration
		// only imports contact-scoped knowledge; the message is still counted.
		if (!contactId) return;

		await ctx.runAction(internal.knowledge.extraction.extractFromMailMessage, {
			mailMessageId: msg._id,
			contactIds: [contactId],
		});
	} catch (err) {
		// The migration id and message id make the gap traceable afterwards.
		logError('[mailMigration] extraction failed for one message', {
			migrationId,
			mailMessageId: msg._id,
			error: err,
		});
	}
}

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
		// without real-time waits (mirrors messageBackfill.runChunk).
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

			// Work through the chunk a few messages at a time, and stop taking new
			// ones once the time budget is spent: one extraction is a 20-60s LLM
			// call, so a whole chunk in sequence outran Convex's action limit, and
			// an action killed mid-chunk never reschedules — the migration sat at
			// `indexing` forever. Whatever is left is the next invocation's.
			// The first group always runs, so every invocation makes progress.
			const startedAt = Date.now();
			let processed = 0;
			while (processed < messages.length) {
				if (processed > 0 && Date.now() - startedAt >= CHUNK_TIME_BUDGET_MS) break;
				const group = messages.slice(processed, processed + INDEX_CONCURRENCY);
				await Promise.all(group.map((msg) => indexOneMessage(ctx, args.migrationId, msg)));
				processed += group.length;
			}
			const done = messages.slice(0, processed);
			const last = done[done.length - 1];
			const deltaIndexed = done.length;
			const lastReceivedAt = last?.receivedAt;
			const lastId = last?._id;
			const moreToDo = hasMore || processed < messages.length;

			await ctx.runMutation(internal.mail.migrationIndexing.patchIndexProgress, {
				migrationId: args.migrationId,
				deltaIndexed,
				cursorReceivedAt: lastReceivedAt,
				cursorId: lastId,
			});

			if (moreToDo) {
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
			// The chunk is abandoned and the migration row is marked failed below,
			// so the operator sees this in the UI as well as in the logs.
			logError('[mailMigration] runIndexChunk failed', {
				migrationId: args.migrationId,
				error: err,
			});
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
