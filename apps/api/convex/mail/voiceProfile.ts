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
import { internalQuery, internalMutation } from '../_generated/server';
import type { QueryCtx } from '../_generated/server';
import { authedMutation, publicQuery } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { isFeatureEnabled } from '../lib/featureFlags';
import { loadOwnedMailbox } from './permissions';
import { throwForbidden } from '../_utils/errors';
import { splitQuotedHtml, splitQuotedText } from '@owlat/shared/quotedText';

// ── Tuning ────────────────────────────────────────────────────────────────

/** Max SENT messages sampled per derivation. */
export const VOICE_SAMPLE_SIZE = 30;
/** Per-sample character cap so one long email can't dominate the prompt. */
export const VOICE_SAMPLE_CHARS = 1500;
/** Recompute if the profile is older than this. */
export const VOICE_STALE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
/** …or if this many new sent messages have accumulated since. */
export const VOICE_SENT_DELTA = 20;

// ── Shape ─────────────────────────────────────────────────────────────────

export const voiceProfileValidator = v.object({
	greetings: v.array(v.string()),
	signOffs: v.array(v.string()),
	formality: v.number(),
	brevity: v.number(),
	languages: v.array(v.string()),
	usesEmoji: v.boolean(),
	examplePhrasings: v.array(v.string()),
});

export interface VoiceProfile {
	greetings: string[];
	signOffs: string[];
	formality: number;
	brevity: number;
	languages: string[];
	usesEmoji: boolean;
	examplePhrasings: string[];
}

interface VoiceRowLike {
	status: 'idle' | 'refreshing';
	lastComputedAt?: number;
	sentCountAtCompute: number;
	profile?: VoiceProfile;
}

// ── Pure helpers (unit-tested directly) ─────────────────────────────────────

/**
 * Is this profile stale enough to warrant a background recompute? True when it
 * has never been computed, is older than {@link VOICE_STALE_MS}, or has
 * accumulated {@link VOICE_SENT_DELTA}+ new sent messages since it was learned.
 */
export function isVoiceProfileStale(
	row: VoiceRowLike,
	currentSentCount: number,
	now: number
): boolean {
	if (!row.profile || row.lastComputedAt == null) return true;
	if (now - row.lastComputedAt >= VOICE_STALE_MS) return true;
	if (currentSentCount - row.sentCountAtCompute >= VOICE_SENT_DELTA) return true;
	return false;
}

/** Minimal, dependency-free HTML→text for sampling (not for rendering). */
function htmlToPlainText(html: string): string {
	return html
		.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&quot;/gi, '"')
		.replace(/[ \t]+/g, ' ')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

export interface RawSentBody {
	textBodyInline?: string;
	htmlBodyInline?: string;
	snippet?: string;
}

/**
 * The user's own "fresh" prose for one sent message: the quoted reply-chain
 * (other people's words) is stripped with the same heuristics the composer
 * uses, HTML is flattened to text, and the result is bounded.
 */
export function extractSampleText(raw: RawSentBody): string {
	let text: string;
	if (raw.textBodyInline && raw.textBodyInline.trim()) {
		text = splitQuotedText(raw.textBodyInline).fresh;
	} else if (raw.htmlBodyInline && raw.htmlBodyInline.trim()) {
		text = htmlToPlainText(splitQuotedHtml(raw.htmlBodyInline).fresh);
	} else {
		text = raw.snippet ?? '';
	}
	return text.trim().slice(0, VOICE_SAMPLE_CHARS);
}

/** Build the bounded, non-empty sample set fed to the LLM. */
export function buildVoiceSamples(rows: RawSentBody[], max = VOICE_SAMPLE_SIZE): string[] {
	const out: string[] = [];
	for (const r of rows) {
		const s = extractSampleText(r);
		if (s.length > 0) out.push(s);
		if (out.length >= max) break;
	}
	return out;
}

/**
 * The "match this user's voice" prompt section, or null when there is no
 * profile to inject (caller omits the section entirely — no empty scaffolding).
 */
export function buildVoiceGuidance(profile: VoiceProfile | null | undefined): string | null {
	if (!profile) return null;
	const lines: string[] = [
		"Match this user's personal writing voice (learned from their own sent mail):",
	];
	if (profile.greetings.length) lines.push(`- Typical greetings: ${profile.greetings.join(', ')}`);
	if (profile.signOffs.length) lines.push(`- Typical sign-offs: ${profile.signOffs.join(', ')}`);
	lines.push(`- Formality: ${profile.formality}/5 (1=very casual, 5=very formal)`);
	lines.push(`- Brevity: ${profile.brevity}/5 (1=terse, 5=elaborate)`);
	if (profile.languages.length) lines.push(`- Language(s): ${profile.languages.join(', ')}`);
	lines.push(`- Emoji: ${profile.usesEmoji ? 'occasionally uses emoji' : 'does not use emoji'}`);
	if (profile.examplePhrasings.length) {
		lines.push(`- Example phrasings (for tone only, never copy verbatim): ${profile.examplePhrasings.join(' | ')}`);
	}
	lines.push('Write in this voice while staying appropriate to the thread.');
	return lines.join('\n');
}

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
			.withIndex('by_mailbox_and_role', (q) =>
				q.eq('mailboxId', args.mailboxId).eq('role', 'sent')
			)
			.first();
		if (!sent) return { samples: [], sentCount: 0 };
		const messages = await ctx.db
			.query('mailMessages')
			.withIndex('by_folder_and_received', (q) => q.eq('folderId', sent._id))
			.order('desc')
			.take(VOICE_SAMPLE_SIZE);
		const samples = buildVoiceSamples(
			messages.map((m) => ({
				textBodyInline: m.textBodyInline,
				htmlBodyInline: m.htmlBodyInline,
				snippet: m.snippet,
			}))
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
			enabled: true,
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
 * Read the profile for prompt injection AND lazily schedule a background
 * refresh when it is stale. Internal mutation (not a query) because scheduling
 * is a write; called by mail/ai.ts before it drafts. Returns the guidance block
 * to inject, or null for today's non-personalized behaviour. Never throws —
 * personalization must degrade silently.
 */
export const getGuidanceForMailbox = internalMutation({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args): Promise<{ guidance: string | null }> => {
		const row = await findRow(ctx, args.mailboxId);
		if (!row || !row.enabled) return { guidance: null };
		if (!(await isFeatureEnabled(ctx, 'ai'))) {
			return { guidance: buildVoiceGuidance(row.profile) };
		}
		const sentCount = await currentSentCount(ctx, args.mailboxId);
		if (row.status === 'idle' && isVoiceProfileStale(row, sentCount, Date.now())) {
			await ctx.db.patch(row._id, { status: 'refreshing', updatedAt: Date.now() });
			await ctx.scheduler.runAfter(0, internal.mail.voiceProfileActions.refresh, {
				mailboxId: args.mailboxId,
			});
		}
		return { guidance: buildVoiceGuidance(row.profile) };
	},
});

// ── Public surface (settings) ───────────────────────────────────────────────

/**
 * The derived profile summary for the settings page. Soft-auth: returns null
 * for anonymous / non-owner callers (mailbox ownership enforced in-handler).
 */
// public: soft-auth — ownership enforced via loadOwnedMailbox; returns null otherwise.
export const get = publicQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const owned = await loadOwnedMailbox(ctx, args.mailboxId);
		if (!owned.ok) return null;
		const row = await findRow(ctx, args.mailboxId);
		if (!row) return { enabled: false, profile: null, status: 'idle' as const, lastComputedAt: null };
		return {
			enabled: row.enabled,
			profile: row.profile ?? null,
			status: row.status,
			lastComputedAt: row.lastComputedAt ?? null,
		};
	},
});

/** Toggle "Personalize AI drafts" for a mailbox (creates the row on first use). */
export const setEnabled = authedMutation({
	args: { mailboxId: v.id('mailboxes'), enabled: v.boolean() },
	// authz: ownership enforced via loadOwnedMailbox.
	handler: async (ctx, args) => {
		const owned = await loadOwnedMailbox(ctx, args.mailboxId);
		if (!owned.ok) throwForbidden('Mailbox not found');
		const now = Date.now();
		const row = await findRow(ctx, args.mailboxId);
		if (row) {
			await ctx.db.patch(row._id, { enabled: args.enabled, updatedAt: now });
			return row._id;
		}
		return ctx.db.insert('mailVoiceProfiles', {
			mailboxId: args.mailboxId,
			enabled: args.enabled,
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
	// authz: ownership enforced via loadOwnedMailbox.
	handler: async (ctx, args) => {
		const owned = await loadOwnedMailbox(ctx, args.mailboxId);
		if (!owned.ok) throwForbidden('Mailbox not found');
		if (!(await isFeatureEnabled(ctx, 'ai'))) throwForbidden('AI features are disabled');
		const now = Date.now();
		const row = await findRow(ctx, args.mailboxId);
		if (row) {
			await ctx.db.patch(row._id, { enabled: true, status: 'refreshing', updatedAt: now });
		} else {
			await ctx.db.insert('mailVoiceProfiles', {
				mailboxId: args.mailboxId,
				enabled: true,
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
