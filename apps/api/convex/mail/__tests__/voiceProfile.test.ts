/**
 * Pure-logic tests for the writing-voice profile (mail/voiceProfile):
 *
 *   - isVoiceProfileStale: fresh → no recompute; old / delta / never-computed → stale
 *   - buildVoiceGuidance: full block when a profile is present, null when absent
 *   - extractSampleText / buildVoiceSamples: quoted reply-chains stripped so the
 *     model learns the user's own prose (text + HTML variants), empties dropped
 */

import { describe, it, expect } from 'vitest';
import {
	isVoiceProfileStale,
	buildVoiceGuidance,
	extractSampleText,
	buildVoiceSamples,
	VOICE_STALE_MS,
	VOICE_SENT_DELTA,
	type VoiceProfile,
} from '../voiceProfile';

const PROFILE: VoiceProfile = {
	greetings: ['Hi', 'Hey'],
	signOffs: ['Cheers', 'Best'],
	formality: 2,
	brevity: 2,
	languages: ['English'],
	isEmojiUser: true,
	examplePhrasings: ['sounds good', 'let me know'],
};

describe('isVoiceProfileStale', () => {
	const now = 1_700_000_000_000;

	it('is not stale for a recently computed profile with few new sends', () => {
		expect(
			isVoiceProfileStale(
				{ status: 'idle', profile: PROFILE, lastComputedAt: now, sentCountAtCompute: 100 },
				105,
				now
			)
		).toBe(false);
	});

	it('is stale when never computed (no profile)', () => {
		expect(
			isVoiceProfileStale({ status: 'idle', sentCountAtCompute: 0 }, 0, now)
		).toBe(true);
	});

	it('is stale once older than the staleness window', () => {
		expect(
			isVoiceProfileStale(
				{
					status: 'idle',
					profile: PROFILE,
					lastComputedAt: now - VOICE_STALE_MS - 1,
					sentCountAtCompute: 100,
				},
				101,
				now
			)
		).toBe(true);
	});

	it('is stale once enough new sent messages accumulate', () => {
		expect(
			isVoiceProfileStale(
				{ status: 'idle', profile: PROFILE, lastComputedAt: now, sentCountAtCompute: 100 },
				100 + VOICE_SENT_DELTA,
				now
			)
		).toBe(true);
	});
});

describe('buildVoiceGuidance', () => {
	it('returns null when there is no profile (caller omits the section)', () => {
		expect(buildVoiceGuidance(null)).toBeNull();
		expect(buildVoiceGuidance(undefined)).toBeNull();
	});

	it('renders the profile fields when present', () => {
		const g = buildVoiceGuidance(PROFILE);
		expect(g).toContain("Match this user's personal writing voice");
		expect(g).toContain('Typical greetings: Hi, Hey');
		expect(g).toContain('Typical sign-offs: Cheers, Best');
		expect(g).toContain('Formality: 2/5');
		expect(g).toContain('Brevity: 2/5');
		expect(g).toContain('Language(s): English');
		expect(g).toContain('occasionally uses emoji');
		expect(g).toContain('sounds good | let me know');
	});

	it('omits empty list sections cleanly', () => {
		const g = buildVoiceGuidance({ ...PROFILE, greetings: [], examplePhrasings: [] });
		expect(g).not.toContain('Typical greetings');
		expect(g).not.toContain('Example phrasings');
		// Scalar fields still render.
		expect(g).toContain('Formality: 2/5');
	});
});

describe('extractSampleText / buildVoiceSamples', () => {
	it('strips a plain-text quoted reply chain (attribution + > lines)', () => {
		const body =
			"Hi Bob,\n\nSounds good — let's meet Friday.\n\nBest,\nAlice\n\n" +
			'On Mon, Jan 1, 2024, Bob <bob@x.com> wrote:\n> Can we meet this week?';
		const sample = extractSampleText({ textBodyInline: body });
		expect(sample).toContain('Sounds good');
		expect(sample).toContain('Best,');
		expect(sample).not.toContain('Can we meet this week');
		expect(sample).not.toContain('wrote:');
	});

	it('strips an HTML Gmail quote and flattens to text', () => {
		const html =
			'<p>Thanks, that works for me!</p>' +
			'<div class="gmail_quote"><blockquote>Original: are you free?</blockquote></div>';
		const sample = extractSampleText({ htmlBodyInline: html });
		expect(sample).toContain('Thanks, that works for me!');
		expect(sample).not.toContain('are you free');
		expect(sample).not.toContain('<');
	});

	it('falls back to the snippet when no body is inline', () => {
		expect(extractSampleText({ snippet: 'quick note' })).toBe('quick note');
	});

	it('drops empty samples and caps the count', () => {
		const rows = [
			{ textBodyInline: 'real content one' },
			{ textBodyInline: '   ' },
			{ htmlBodyInline: '<p>real content two</p>' },
		];
		const samples = buildVoiceSamples(rows, 2);
		expect(samples).toEqual(['real content one', 'real content two']);
	});
});
