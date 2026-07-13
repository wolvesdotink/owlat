/**
 * Per-identity (mailbox) writing-voice profile.
 *
 * Advisory AI drafts sound more like the user when the prompt is told how the
 * user actually writes. We derive that from the user's own SENT mail: a bounded
 * sample of recent sent bodies (quoted reply-chains stripped, since those are
 * other people's words) is summarised by one cheap-tier LLM call into a compact
 * structured profile (see mail/voiceProfileActions.ts). This file holds the
 * v8-runtime surface — the sampling query, the persistence mutations, the
 * lazy-refresh scheduler, the read/toggle public functions, and the pure
 * helpers (staleness, sample building, prompt assembly) that back the tests.
 *
 * Fail-soft by construction: no row, personalization off, or no derived profile
 * yet all collapse to exactly today's non-personalized behaviour. Refreshes run
 * in the background via the scheduler and never block a user-facing call.
 */

import { v } from 'convex/values';
import { mailMessageInlineBody } from '../lib/messageBody';
import { internalQuery, internalMutation } from '../_generated/server';
import type { QueryCtx, MutationCtx } from '../_generated/server';
import { authedMutation, publicQuery } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { isFeatureEnabled } from '../lib/featureFlags';
import { requireMailboxAccess } from './permissions';
import { throwForbidden } from '../_utils/errors';
import { extractEmail } from '../lib/emailAddress';
import {
	buildLayeredGuidance,
	promotedDirectives,
	medianEditDistance,
	type EditDeltaKind,
} from './editLearning';
// Tuning constants, the profile shape, and the pure staleness/sampling/prompt
// helpers live in the sibling voiceProfileText.ts (keeps this Convex-runtime
// module under the file-size cap). Re-exported here so existing importers and
// the unit tests keep their `./voiceProfile` import path.
import {
	VOICE_SAMPLE_SIZE,
	voiceProfileValidator,
	isVoiceProfileStale,
	buildVoiceSamples,
	buildVoiceGuidance,
} from './voiceProfileText';
export {
	VOICE_SAMPLE_SIZE,
	VOICE_SAMPLE_CHARS,
	VOICE_STALE_MS,
	VOICE_SENT_DELTA,
	voiceProfileValidator,
	isVoiceProfileStale,
	extractSampleText,
	buildVoiceSamples,
	buildVoiceGuidance,
} from './voiceProfileText';
export type { VoiceProfile, RawSentBody } from './voiceProfileText';

// ── Internal data access ────────────────────────────────────────────────────

async function findRow(ctx: QueryCtx, mailboxId: Id<'mailboxes'>) {
	return ctx.db
		.query('mailVoiceProfiles')
		.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailboxId))
		.first();
}

async function currentSentCount(ctx: QueryCtx, mailboxId: Id<'mailboxes'>): Promise<number> {
	const sent = await ctx.db
		.query('mailFolders')
		.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', mailboxId).eq('role', 'sent'))
		.first();
	return sent?.totalCount ?? 0;
}

/**
 * Recent SENT bodies for a mailbox, quoted-text stripped and bounded, plus the
 * live sent-folder message count (for staleness accounting). Internal — called
 * by the refresh action.
 */
export const sampleSentBodies = internalQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args): Promise<{ samples: string[]; sentCount: number }> => {
		const sent = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', args.mailboxId).eq('role', 'sent'))
			.first();
		if (!sent) return { samples: [], sentCount: 0 };
		const messages = await ctx.db
			.query('mailMessages')
			.withIndex('by_folder_and_received', (q) => q.eq('folderId', sent._id))
			.order('desc')
			.take(VOICE_SAMPLE_SIZE);
		const samples = buildVoiceSamples(
			messages.map((m) => {
				const { text, html } = mailMessageInlineBody(m);
				return {
					textBodyInline: text,
					htmlBodyInline: html,
					snippet: m.snippet,
				};
			})
		);
		return { samples, sentCount: sent.totalCount };
	},
});

/** Persist a freshly derived profile and clear the refreshing flag. */
export const saveProfile = internalMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		profile: voiceProfileValidator,
		sampleCount: v.number(),
		sentCount: v.number(),
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		const row = await findRow(ctx, args.mailboxId);
		const patch = {
			profile: args.profile,
			sampleCount: args.sampleCount,
			sentCountAtCompute: args.sentCount,
			lastComputedAt: now,
			status: 'idle' as const,
			updatedAt: now,
		};
		if (row) {
			await ctx.db.patch(row._id, patch);
			return row._id;
		}
		return ctx.db.insert('mailVoiceProfiles', {
			mailboxId: args.mailboxId,
			isEnabled: true,
			createdAt: now,
			...patch,
		});
	},
});

/** Release the refreshing flag without changing the (possibly absent) profile. */
export const markIdle = internalMutation({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const row = await findRow(ctx, args.mailboxId);
		if (row && row.status !== 'idle') {
			await ctx.db.patch(row._id, { status: 'idle', updatedAt: Date.now() });
		}
	},
});

/**
 * Promoted per-recipient style directives for one address, or [] when there is
 * no override row / no promoted rule yet. Keyed by the exact lowercased address
 * so an override learned for contact X is only ever blended when drafting to X.
 */
async function contactStyleDirectives(
	ctx: MutationCtx,
	mailboxId: Id<'mailboxes'>,
	recipient: string
): Promise<string[]> {
	const address = extractEmail(recipient);
	if (!address) return [];
	const row = await ctx.db
		.query('mailContactStyleOverrides')
		.withIndex('by_mailbox_and_address', (q) =>
			q.eq('mailboxId', mailboxId).eq('contactAddress', address)
		)
		.first();
	if (!row) return [];
	return promotedDirectives(row.adjustments);
}

/**
 * Shared core for the guidance accessors: read the profile for prompt injection
 * AND lazily schedule a background refresh when it is stale. Returns the
 * guidance block to inject, or null for today's non-personalized behaviour.
 * Scheduling is a write, so callers must be mutations.
 */
async function guidanceForMailbox(
	ctx: MutationCtx,
	mailboxId: Id<'mailboxes'>,
	recipient?: string
): Promise<{ guidance: string | null }> {
	const row = await findRow(ctx, mailboxId);
	if (!row || !row.isEnabled) return { guidance: null };
	// Lazy background refresh of the SAMPLED voice profile (gated on `ai`); the
	// derived/standing/contact layers below are served regardless so learning
	// surfaces even when the sampler is idle.
	if (await isFeatureEnabled(ctx, 'ai')) {
		const sentCount = await currentSentCount(ctx, mailboxId);
		if (row.status === 'idle' && isVoiceProfileStale(row, sentCount, Date.now())) {
			await ctx.db.patch(row._id, { status: 'refreshing', updatedAt: Date.now() });
			await ctx.scheduler.runAfter(0, internal.mail.voiceProfileActions.refresh, {
				mailboxId,
			});
		}
	}
	const contactDirectives = recipient
		? await contactStyleDirectives(ctx, mailboxId, recipient)
		: [];
	const guidance = buildLayeredGuidance({
		standingInstructions: row.standingInstructions ?? [],
		voiceBlock: buildVoiceGuidance(row.profile),
		derivedDirectives: promotedDirectives(row.derivedAdjustments ?? []),
		contactDirectives,
	});
	return { guidance };
}

/**
 * Read the profile for prompt injection AND lazily schedule a background
 * refresh when it is stale. Internal mutation (not a query) because scheduling
 * is a write; called by mail/ai.ts before it drafts. Returns the guidance block
 * to inject, or null for today's non-personalized behaviour. Never throws —
 * personalization must degrade silently.
 */
export const getGuidanceForMailbox = internalMutation({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args): Promise<{ guidance: string | null }> =>
		guidanceForMailbox(ctx, args.mailboxId),
});

/**
 * Same guidance accessor, keyed by the recipient email address instead of a
 * mailbox id. Used by the autonomous agent draft step, whose inbound message
 * carries the recipient (`to`) but not a resolved Postbox mailbox. Resolves the
 * mailbox by its canonical address (same derivation as inbound sender/thread
 * matching); no matching mailbox -> no guidance. Never throws — personalization
 * must degrade silently to today's generic org tone.
 */
export const getGuidanceForRecipient = internalMutation({
	args: { recipient: v.string() },
	handler: async (ctx, args): Promise<{ guidance: string | null }> => {
		const address = extractEmail(args.recipient);
		if (!address) return { guidance: null };
		const mailbox = await ctx.db
			.query('mailboxes')
			.withIndex('by_address', (q) => q.eq('address', address))
			.first();
		if (!mailbox) return { guidance: null };
		// Pass the recipient through so the per-contact override for this exact
		// address is blended in (never any other contact's override).
		return guidanceForMailbox(ctx, mailbox._id, args.recipient);
	},
});

// ── Public surface (settings) ───────────────────────────────────────────────

/**
 * The derived profile summary for the settings page. Soft-auth: returns null
 * for anonymous / non-owner callers (mailbox access enforced in-handler).
 */
// public: soft-auth — access enforced via requireMailboxAccess; returns null otherwise.
export const get = publicQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) return null;
		const row = await findRow(ctx, args.mailboxId);
		if (!row) {
			return {
				isEnabled: false,
				profile: null,
				status: 'idle' as const,
				lastComputedAt: null,
				standingInstructions: [],
				derivedAdjustments: [],
				editDistanceMedian: null,
			};
		}
		// Surface only the PROMOTED (durable, active) learned adjustments so the
		// settings UI can list and revoke real rules, not pending observations.
		const durable: Array<{ kind: EditDeltaKind; directive: string; observations: number }> = [];
		for (const adj of row.derivedAdjustments ?? []) {
			if (adj.promoted) {
				durable.push({ kind: adj.kind, directive: adj.directive, observations: adj.observations });
			}
		}
		return {
			isEnabled: row.isEnabled,
			profile: row.profile ?? null,
			status: row.status,
			lastComputedAt: row.lastComputedAt ?? null,
			standingInstructions: row.standingInstructions ?? [],
			derivedAdjustments: durable,
			// North-star metric: median normalized draft→sent edit distance.
			editDistanceMedian: medianEditDistance(row.editDistanceSamples ?? []),
		};
	},
});

/** Max standing instructions retained, and per-instruction character bound. */
export const MAX_STANDING_INSTRUCTIONS = 20;
export const MAX_STANDING_INSTRUCTION_CHARS = 200;

/**
 * Replace the mailbox's user-authored standing instructions ("never use
 * exclamation marks", "sign as Dr."). These are explicit rules, merged ABOVE the
 * derived voice at draft time. Trimmed, de-duplicated, empties dropped, bounded.
 */
export const setStandingInstructions = authedMutation({
	args: { mailboxId: v.id('mailboxes'), instructions: v.array(v.string()) },
	// authz: access enforced via requireMailboxAccess.
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) throwForbidden('Mailbox not found');
		const seen = new Set<string>();
		const cleaned: string[] = [];
		for (const raw of args.instructions) {
			const trimmed = raw.trim().slice(0, MAX_STANDING_INSTRUCTION_CHARS);
			if (trimmed.length === 0) continue;
			const key = trimmed.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			cleaned.push(trimmed);
			if (cleaned.length >= MAX_STANDING_INSTRUCTIONS) break;
		}
		const now = Date.now();
		const row = await findRow(ctx, args.mailboxId);
		if (row) {
			await ctx.db.patch(row._id, { standingInstructions: cleaned, updatedAt: now });
			return row._id;
		}
		return ctx.db.insert('mailVoiceProfiles', {
			mailboxId: args.mailboxId,
			isEnabled: true,
			status: 'idle',
			sampleCount: 0,
			sentCountAtCompute: 0,
			standingInstructions: cleaned,
			createdAt: now,
			updatedAt: now,
		});
	},
});

/**
 * Revoke one learned voice-level adjustment by kind ("stop applying this rule").
 * Drops it entirely so it neither injects nor keeps its observation count.
 */
export const removeDerivedAdjustment = authedMutation({
	args: { mailboxId: v.id('mailboxes'), kind: v.string() },
	// authz: access enforced via requireMailboxAccess.
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) throwForbidden('Mailbox not found');
		const row = await findRow(ctx, args.mailboxId);
		if (!row || !row.derivedAdjustments) return null;
		const kept: typeof row.derivedAdjustments = [];
		for (const adj of row.derivedAdjustments) {
			if (adj.kind !== args.kind) kept.push(adj);
		}
		await ctx.db.patch(row._id, { derivedAdjustments: kept, updatedAt: Date.now() });
		return null;
	},
});

/** Toggle "Personalize AI drafts" for a mailbox (creates the row on first use). */
export const setEnabled = authedMutation({
	args: { mailboxId: v.id('mailboxes'), enabled: v.boolean() },
	// authz: access enforced via requireMailboxAccess.
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) throwForbidden('Mailbox not found');
		const now = Date.now();
		const row = await findRow(ctx, args.mailboxId);
		if (row) {
			await ctx.db.patch(row._id, { isEnabled: args.enabled, updatedAt: now });
			return row._id;
		}
		return ctx.db.insert('mailVoiceProfiles', {
			mailboxId: args.mailboxId,
			isEnabled: args.enabled,
			status: 'idle',
			sampleCount: 0,
			sentCountAtCompute: 0,
			createdAt: now,
			updatedAt: now,
		});
	},
});

/**
 * Force a refresh now ("Refresh now" button). Gated on the `ai` feature. Sets
 * the row refreshing and schedules the background action; the profile updates
 * out of band so the call returns immediately.
 */
export const requestRefresh = authedMutation({
	args: { mailboxId: v.id('mailboxes') },
	// authz: access enforced via requireMailboxAccess.
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) throwForbidden('Mailbox not found');
		if (!(await isFeatureEnabled(ctx, 'ai'))) throwForbidden('AI features are disabled');
		const now = Date.now();
		const row = await findRow(ctx, args.mailboxId);
		if (row) {
			await ctx.db.patch(row._id, { isEnabled: true, status: 'refreshing', updatedAt: now });
		} else {
			await ctx.db.insert('mailVoiceProfiles', {
				mailboxId: args.mailboxId,
				isEnabled: true,
				status: 'refreshing',
				sampleCount: 0,
				sentCountAtCompute: 0,
				createdAt: now,
				updatedAt: now,
			});
		}
		await ctx.scheduler.runAfter(0, internal.mail.voiceProfileActions.refresh, {
			mailboxId: args.mailboxId,
		});
		return null;
	},
});
