/**
 * Edit-learning flywheel — close the loop on the AI's OWN drafts.
 *
 * The voice profile (mail/voiceProfile.ts) learns from a passive SAMPLE of the
 * user's sent mail. It never learns from the richest, freest ground-truth signal
 * Owlat holds: how the user EDITS an AI draft before sending it. This module
 * captures that delta.
 *
 * When a draft that carries an `aiDraftBaseline` (the AI's original text) is
 * sent, the draft-lifecycle sent-effect schedules {@link recordEdit}. That
 * mutation DIFFS baseline → sent, classifies the change into a small fixed
 * vocabulary of recurring habits (removed a greeting, shortened, switched
 * language for this contact, …), and folds each habit into either:
 *   (a) the mailbox voice profile's `derivedAdjustments` (global habits), or
 *   (b) a per-recipient `mailContactStyleOverrides` row (recipient-specific,
 *       e.g. always replies to contact X in German).
 *
 * A delta only becomes a DURABLE, injected rule after it has been observed
 * {@link EDIT_RECURRENCE_THRESHOLD} times — a one-off edit never sticks. Every
 * promoted rule is inspectable and revocable from settings.
 *
 * Layering at draft time (highest priority first): user standing instructions →
 * derived voice profile → derived global adjustments → this-recipient overrides.
 *
 * North-star metric: the median normalized draft→sent edit distance, tracked in
 * a bounded rolling window on the voice row.
 *
 * Fail-soft by construction: this module is PURE + one internalMutation that
 * swallows every error. Nothing here blocks a send, auto-sends, or wedges a
 * walker; drafts are always shown to a human who edits/approves them. No
 * baseline → no learning → exactly today's behaviour.
 *
 * NOT `'use node'`: all logic is deterministic string work — no LLM, no fetch.
 */

import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { extractEmail } from '../lib/emailAddress';
import { logError } from '../lib/runtimeLog';

// ── Tuning ──────────────────────────────────────────────────────────────────

/** Observations of the SAME delta before it becomes a durable, injected rule. */
export const EDIT_RECURRENCE_THRESHOLD = 3;
/** Max edit-distance samples retained for the median metric (rolling window). */
export const EDIT_DISTANCE_WINDOW = 50;
/** Cap the O(n·m) diff so a pathological pair can never blow the step budget. */
const DIFF_MAX_CHARS = 4000;

// ── Vocabulary ──────────────────────────────────────────────────────────────

export type EditDeltaKind =
	| 'removed_greeting'
	| 'added_greeting'
	| 'removed_signoff'
	| 'added_signoff'
	| 'shortened'
	| 'lengthened'
	| 'removed_emoji'
	| 'removed_exclamation'
	| 'language_switch';

export interface EditAdjustment {
	kind: EditDeltaKind;
	directive: string;
	observations: number;
	promoted: boolean;
	firstSeenAt: number;
	lastSeenAt: number;
}

/** The durable prompt directive each recurring delta turns into. */
export const DELTA_DIRECTIVE: Record<EditDeltaKind, string> = {
	removed_greeting: 'Skip the opening greeting; start directly with the message.',
	added_greeting: 'Open with a brief greeting.',
	removed_signoff: 'Do not add a sign-off line.',
	added_signoff: 'End with a short sign-off.',
	shortened: 'Keep replies short and to the point.',
	lengthened: 'Add a little more detail than a bare reply.',
	removed_emoji: 'Do not use emoji.',
	removed_exclamation: 'Avoid exclamation marks.',
	language_switch: "Reply in this recipient's preferred language, not the default one.",
};

/**
 * Which deltas are RECIPIENT-specific (stored per-contact) vs GLOBAL habits
 * (stored on the voice profile). Language choice is inherently per-recipient;
 * structural habits (greeting/sign-off/length/emoji/punctuation) are global.
 */
const CONTACT_LEVEL: ReadonlySet<EditDeltaKind> = new Set(['language_switch']);

export function isContactLevelKind(kind: EditDeltaKind): boolean {
	return CONTACT_LEVEL.has(kind);
}
export function isVoiceLevelKind(kind: EditDeltaKind): boolean {
	return !CONTACT_LEVEL.has(kind);
}

// ── Text helpers ────────────────────────────────────────────────────────────

function stripHtml(input: string): string {
	return input
		.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/[ \t]+/g, ' ')
		.replace(/\n{3,}/g, '\n\n');
}

/** Normalize either HTML or plain text into comparable plain text. */
export function normalizeBody(input: string): string {
	const looksHtml = /<[a-z!/][\s\S]*>/i.test(input);
	const text = looksHtml ? stripHtml(input) : input;
	return text.replace(/\r\n?/g, '\n').trim();
}

function nonEmptyLines(text: string): string[] {
	const out: string[] = [];
	for (const raw of text.split('\n')) {
		const line = raw.trim();
		if (line.length > 0) out.push(line);
	}
	return out;
}

function wordCount(text: string): number {
	const trimmed = text.trim();
	if (trimmed.length === 0) return 0;
	return trimmed.split(/\s+/).length;
}

const GREETING_RE = /^(hi|hello|hey|dear|good (morning|afternoon|evening)|greetings|hej|hola|bonjour|hallo|salut)\b/i;
const SIGNOFF_RE = /^(thanks|thank you|cheers|best|regards|best regards|kind regards|warm regards|sincerely|yours|talk soon|speak soon|all the best|many thanks)\b/i;
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u;

export function hasGreeting(text: string): boolean {
	const lines = nonEmptyLines(text);
	if (lines.length === 0) return false;
	const first = lines[0] ?? '';
	return GREETING_RE.test(first) && wordCount(first) <= 6;
}

export function hasSignoff(text: string): boolean {
	const lines = nonEmptyLines(text);
	// Inspect the last two non-empty lines (sign-off + name).
	for (let i = Math.max(0, lines.length - 2); i < lines.length; i++) {
		const line = lines[i] ?? '';
		if (SIGNOFF_RE.test(line) && wordCount(line) <= 5) return true;
	}
	return false;
}

/**
 * Coarse dominant-script classifier — enough to detect a language switch
 * between drafts (latin ↔ cyrillic ↔ cjk ↔ greek) without a heavy NLP dep.
 * Returns 'latin' when there is no strong non-latin signal.
 */
export function dominantScript(text: string): 'latin' | 'cyrillic' | 'cjk' | 'greek' {
	let cyr = 0;
	let cjk = 0;
	let grk = 0;
	let latin = 0;
	for (const ch of text) {
		const c = ch.codePointAt(0) ?? 0;
		if (c >= 0x0400 && c <= 0x04ff) cyr++;
		else if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3040 && c <= 0x30ff)) cjk++;
		else if (c >= 0x0370 && c <= 0x03ff) grk++;
		else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) latin++;
	}
	const max = Math.max(cyr, cjk, grk, latin);
	if (max === 0) return 'latin';
	if (max === cyr) return 'cyrillic';
	if (max === cjk) return 'cjk';
	if (max === grk) return 'greek';
	return 'latin';
}

// ── Diff + classification ───────────────────────────────────────────────────

/**
 * Normalized Levenshtein distance in [0, 1] — 0 = identical, 1 = fully rewritten.
 * Inputs are normalized to plain text and capped so the O(n·m) DP stays bounded.
 */
export function normalizedEditDistance(baseline: string, sent: string): number {
	const a = normalizeBody(baseline).slice(0, DIFF_MAX_CHARS);
	const b = normalizeBody(sent).slice(0, DIFF_MAX_CHARS);
	if (a.length === 0 && b.length === 0) return 0;
	const maxLen = Math.max(a.length, b.length);
	if (a.length === 0 || b.length === 0) return 1;

	let prev = new Array<number>(b.length + 1);
	let curr = new Array<number>(b.length + 1);
	for (let j = 0; j <= b.length; j++) prev[j] = j;
	for (let i = 1; i <= a.length; i++) {
		curr[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(
				(prev[j] ?? 0) + 1,
				(curr[j - 1] ?? 0) + 1,
				(prev[j - 1] ?? 0) + cost,
			);
		}
		const tmp = prev;
		prev = curr;
		curr = tmp;
	}
	return (prev[b.length] ?? maxLen) / maxLen;
}

/**
 * Classify the recurring, teachable deltas between the AI baseline and what the
 * user actually sent. Returns a de-duplicated list of {@link EditDeltaKind}.
 * Pure + heuristic: only high-signal, unambiguous structural changes count, so
 * noise does not manufacture rules. An empty result means "nothing to learn".
 */
export function classifyEdits(baseline: string, sent: string): EditDeltaKind[] {
	const a = normalizeBody(baseline);
	const b = normalizeBody(sent);
	const kinds: EditDeltaKind[] = [];
	if (a.length === 0 || b.length === 0) return kinds;

	// Greeting add/remove.
	const ag = hasGreeting(a);
	const bg = hasGreeting(b);
	if (ag && !bg) kinds.push('removed_greeting');
	else if (!ag && bg) kinds.push('added_greeting');

	// Sign-off add/remove.
	const as = hasSignoff(a);
	const bs = hasSignoff(b);
	if (as && !bs) kinds.push('removed_signoff');
	else if (!as && bs) kinds.push('added_signoff');

	// Length shift.
	const aw = wordCount(a);
	const bw = wordCount(b);
	if (aw >= 8) {
		const ratio = bw / aw;
		if (ratio <= 0.7) kinds.push('shortened');
		else if (ratio >= 1.4) kinds.push('lengthened');
	}

	// Emoji / exclamation removal (only "AI had it, user took it out").
	if (EMOJI_RE.test(a) && !EMOJI_RE.test(b)) kinds.push('removed_emoji');
	if (a.includes('!') && !b.includes('!')) kinds.push('removed_exclamation');

	// Language switch (recipient-specific).
	if (dominantScript(a) !== dominantScript(b)) kinds.push('language_switch');

	return kinds;
}

// ── Adjustment accumulation (recurrence threshold) ──────────────────────────

/**
 * Fold one observed delta into an adjustment list, returning a NEW list. The
 * matching adjustment's observation count is incremented (or a fresh one is
 * appended at count 1); `promoted` flips true once observations reach
 * {@link EDIT_RECURRENCE_THRESHOLD}. This is the sole gate that stops a one-off
 * edit from becoming a durable rule.
 */
export function mergeAdjustment(
	list: readonly EditAdjustment[],
	kind: EditDeltaKind,
	now: number,
	threshold: number = EDIT_RECURRENCE_THRESHOLD,
): { list: EditAdjustment[]; justPromoted: boolean } {
	const next: EditAdjustment[] = [];
	let matched = false;
	let justPromoted = false;
	for (const adj of list) {
		if (adj.kind === kind) {
			matched = true;
			const observations = adj.observations + 1;
			const promoted = observations >= threshold;
			if (promoted && !adj.promoted) justPromoted = true;
			next.push({
				...adj,
				directive: DELTA_DIRECTIVE[kind],
				observations,
				promoted,
				lastSeenAt: now,
			});
		} else {
			next.push(adj);
		}
	}
	if (!matched) {
		const promoted = 1 >= threshold;
		if (promoted) justPromoted = true;
		next.push({
			kind,
			directive: DELTA_DIRECTIVE[kind],
			observations: 1,
			promoted,
			firstSeenAt: now,
			lastSeenAt: now,
		});
	}
	return { list: next, justPromoted };
}

/** The directives of the PROMOTED adjustments only — what actually gets injected. */
export function promotedDirectives(list: readonly EditAdjustment[]): string[] {
	const out: string[] = [];
	for (const adj of list) {
		if (adj.promoted) out.push(adj.directive);
	}
	return out;
}

// ── Edit-distance metric ────────────────────────────────────────────────────

/** Append a sample to the bounded rolling window (oldest dropped past the cap). */
export function pushEditDistanceSample(
	samples: readonly number[],
	value: number,
	max: number = EDIT_DISTANCE_WINDOW,
): number[] {
	const next = [...samples, value];
	if (next.length > max) return next.slice(next.length - max);
	return next;
}

/** Median of the rolling window, or null when there is nothing recorded yet. */
export function medianEditDistance(samples: readonly number[]): number | null {
	if (samples.length === 0) return null;
	const sorted = [...samples].sort((x, y) => x - y);
	const mid = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) return sorted[mid] ?? null;
	return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

// ── Layered guidance assembly ───────────────────────────────────────────────

/**
 * Compose the final "write like the user" block from all four layers, in
 * priority order. Standing instructions come first (explicit user rules),
 * followed by the derived voice block, the learned global adjustments, and the
 * per-recipient overrides. Returns null when every layer is empty, so callers
 * omit the section entirely (today's non-personalized behaviour).
 */
export function buildLayeredGuidance(args: {
	standingInstructions?: readonly string[];
	voiceBlock?: string | null;
	derivedDirectives?: readonly string[];
	contactDirectives?: readonly string[];
}): string | null {
	const sections: string[] = [];

	const standing: string[] = [];
	for (const s of args.standingInstructions ?? []) {
		if (s.trim().length > 0) standing.push(s);
	}
	if (standing.length > 0) {
		sections.push(
			'The user set these standing instructions — always follow them:\n' +
				standing.map((s) => `- ${s.trim()}`).join('\n'),
		);
	}

	if (args.voiceBlock) sections.push(args.voiceBlock);

	const derived = args.derivedDirectives ?? [];
	if (derived.length > 0) {
		sections.push(
			'Learned from how the user edits AI drafts before sending — apply these:\n' +
				derived.map((d) => `- ${d}`).join('\n'),
		);
	}

	const contact = args.contactDirectives ?? [];
	if (contact.length > 0) {
		sections.push(
			'For this specific recipient, the user consistently:\n' +
				contact.map((d) => `- ${d}`).join('\n'),
		);
	}

	return sections.length > 0 ? sections.join('\n\n') : null;
}

// ── Persistence (the flywheel writer) ───────────────────────────────────────

/**
 * Diff a sent message against the AI baseline it was derived from and fold the
 * recurring deltas back into the voice profile (global habits) and per-contact
 * style memory (recipient-specific habits). Scheduled off the draft-lifecycle
 * sent-effect; runs out of band so it never blocks a send.
 *
 * Fail-soft: every error is swallowed and logged — a learning failure must never
 * surface to the user or wedge anything. Records the edit-distance metric even
 * when there is no teachable delta.
 */
export const recordEdit = internalMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		contactAddress: v.optional(v.string()),
		baselineText: v.string(),
		sentText: v.string(),
	},
	handler: async (ctx, args): Promise<null> => {
		try {
			const now = Date.now();
			const distance = normalizedEditDistance(args.baselineText, args.sentText);
			const kinds = classifyEdits(args.baselineText, args.sentText);

			// ── Voice-level: metric + global habit adjustments ──────────────────
			const row = await ctx.db
				.query('mailVoiceProfiles')
				.withIndex('by_mailbox', (q) => q.eq('mailboxId', args.mailboxId))
				.first();
			const samples = pushEditDistanceSample(row?.editDistanceSamples ?? [], distance);
			let derived: EditAdjustment[] = row?.derivedAdjustments
				? [...row.derivedAdjustments]
				: [];
			for (const kind of kinds) {
				if (!isVoiceLevelKind(kind)) continue;
				derived = mergeAdjustment(derived, kind, now).list;
			}
			if (row) {
				await ctx.db.patch(row._id, {
					editDistanceSamples: samples,
					derivedAdjustments: derived,
					updatedAt: now,
				});
			} else {
				await ctx.db.insert('mailVoiceProfiles', {
					mailboxId: args.mailboxId,
					isEnabled: true,
					status: 'idle',
					sampleCount: 0,
					sentCountAtCompute: 0,
					editDistanceSamples: samples,
					derivedAdjustments: derived,
					createdAt: now,
					updatedAt: now,
				});
			}

			// ── Contact-level: per-recipient style overrides ────────────────────
			const address = args.contactAddress ? extractEmail(args.contactAddress) : '';
			let hasContactKind = false;
			for (const kind of kinds) {
				if (isContactLevelKind(kind)) hasContactKind = true;
			}
			if (address && hasContactKind) {
				const existing = await ctx.db
					.query('mailContactStyleOverrides')
					.withIndex('by_mailbox_and_address', (q) =>
						q.eq('mailboxId', args.mailboxId).eq('contactAddress', address),
					)
					.first();
				let adjustments: EditAdjustment[] = existing?.adjustments
					? [...existing.adjustments]
					: [];
				for (const kind of kinds) {
					if (!isContactLevelKind(kind)) continue;
					adjustments = mergeAdjustment(adjustments, kind, now).list;
				}
				if (existing) {
					await ctx.db.patch(existing._id, { adjustments, updatedAt: now });
				} else {
					await ctx.db.insert('mailContactStyleOverrides', {
						mailboxId: args.mailboxId,
						contactAddress: address,
						adjustments,
						createdAt: now,
						updatedAt: now,
					});
				}
			}
		} catch (error) {
			logError(
				`[editLearning] recordEdit failed for mailbox ${args.mailboxId}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		return null;
	},
});
