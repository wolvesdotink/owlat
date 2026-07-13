/**
 * Pure, side-effect-free helpers backing the writing-voice profile
 * (mail/voiceProfile.ts): the tuning constants, the profile shape, and the
 * staleness / sampling / prompt-assembly functions the unit tests exercise
 * directly. Split out of voiceProfile.ts to keep that v8-runtime module under
 * the file-size cap; it holds only the Convex functions and data access.
 *
 * Nothing here touches a Convex ctx or the scheduler — it is deterministic text
 * work, so it stays trivially testable without a Convex harness.
 */

import { v } from 'convex/values';
import { mailMessageInlineBody } from '../lib/messageBody';
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
	isEmojiUser: v.boolean(),
	examplePhrasings: v.array(v.string()),
});

export interface VoiceProfile {
	greetings: string[];
	signOffs: string[];
	formality: number;
	brevity: number;
	languages: string[];
	isEmojiUser: boolean;
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
	const { text: inlineText, html: inlineHtml } = mailMessageInlineBody(raw);
	let text: string;
	if (inlineText && inlineText.trim()) {
		text = splitQuotedText(inlineText).fresh;
	} else if (inlineHtml && inlineHtml.trim()) {
		text = htmlToPlainText(splitQuotedHtml(inlineHtml).fresh);
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
	lines.push(`- Emoji: ${profile.isEmojiUser ? 'occasionally uses emoji' : 'does not use emoji'}`);
	if (profile.examplePhrasings.length) {
		lines.push(
			`- Example phrasings (for tone only, never copy verbatim): ${profile.examplePhrasings.join(' | ')}`
		);
	}
	lines.push('Write in this voice while staying appropriate to the thread.');
	return lines.join('\n');
}
