/**
 * Static spam scoring — the fast, local, network-free half of the engine. It
 * mirrors the class of rules a SpamAssassin-style scorer applies (shouty
 * subject, spam-trigger phrases, excessive punctuation, image-only body, link
 * overload, no plain-text alternative) but keeps them deterministic and bounded
 * so the SAME score can gate a synchronous send. A higher score is WORSE.
 */

import { textContent } from './html';
import type { DeliverabilityEmail, Finding, Verdict } from './types';

/** Weighted rule contribution — points added to the spam score, with a reason. */
interface SpamRuleHit {
	readonly code: string;
	readonly points: number;
	readonly message: string;
}

/** Phrases that classic spam filters weight heavily. Lowercased, matched as substrings. */
const TRIGGER_PHRASES: readonly string[] = Object.freeze([
	'act now',
	'buy now',
	'click here',
	'congratulations',
	'dear friend',
	'double your',
	'earn extra cash',
	'free money',
	'guaranteed',
	'limited time',
	'no obligation',
	'risk free',
	'this is not spam',
	'viagra',
	'winner',
	'work from home',
	'100% free',
]);

/** Thresholds mapping a raw score onto a verdict. `fail` is disqualifying. */
export const SPAM_WARN_THRESHOLD = 5;
export const SPAM_FAIL_THRESHOLD = 10;

/** Points are capped so no single message can produce an unbounded score. */
export const SPAM_SCORE_MAX = 100;

export interface SpamScoreReport {
	/** Non-negative integer, 0 (clean) … {@link SPAM_SCORE_MAX}. Higher is worse. */
	readonly score: number;
	readonly verdict: Verdict;
	readonly findings: readonly Finding[];
}

function bodyText(email: DeliverabilityEmail): string {
	if (email.text && email.text.trim().length > 0) return email.text;
	if (email.html) return textContent(email.html);
	return '';
}

function uppercaseRatio(value: string): number {
	const letters = value.replace(/[^A-Za-z]/g, '');
	if (letters.length === 0) return 0;
	const upper = letters.replace(/[^A-Z]/g, '').length;
	return upper / letters.length;
}

function collectHits(email: DeliverabilityEmail): SpamRuleHit[] {
	const hits: SpamRuleHit[] = [];
	const subject = email.subject.trim();
	const body = bodyText(email);
	const haystack = `${subject}\n${body}`.toLowerCase();

	if (subject.length >= 4 && uppercaseRatio(subject) >= 0.7) {
		hits.push({
			code: 'subject_all_caps',
			points: 4,
			message: 'Subject is almost entirely uppercase, a classic spam signal.',
		});
	}
	const exclamations = (subject.match(/!/g) ?? []).length;
	if (exclamations >= 2) {
		hits.push({
			code: 'subject_exclamations',
			points: 3,
			message: `Subject has ${exclamations} exclamation marks; one is plenty.`,
		});
	}
	if (/\$\d|\b\d+% off\b|\bfree\b/i.test(subject)) {
		hits.push({
			code: 'subject_moneyed',
			points: 2,
			message: 'Subject leads with money/discount language.',
		});
	}

	const matchedPhrases = TRIGGER_PHRASES.filter((phrase) => haystack.includes(phrase));
	if (matchedPhrases.length > 0) {
		hits.push({
			code: 'trigger_phrases',
			// Two points per matched phrase, capped so a phrase-stuffed body cannot
			// dominate the whole (already capped) score on its own.
			points: Math.min(matchedPhrases.length * 2, 12),
			message: `Contains ${matchedPhrases.length} spam-trigger phrase(s): ${matchedPhrases
				.slice(0, 5)
				.join(', ')}.`,
		});
	}

	if (email.html && bodyText({ ...email, text: undefined }).length < 20) {
		const imageCount = (email.html.match(/<img\b/gi) ?? []).length;
		if (imageCount > 0) {
			hits.push({
				code: 'image_only_body',
				points: 6,
				message: 'HTML body is essentially image-only with little readable text.',
			});
		}
	}

	if (email.html && (!email.text || email.text.trim().length === 0)) {
		hits.push({
			code: 'missing_text_part',
			points: 3,
			message: 'No plain-text alternative; many filters penalize HTML-only mail.',
		});
	}

	if (body.length > 0 && body.length < 25) {
		hits.push({
			code: 'thin_body',
			points: 2,
			message: 'Body is very short, which reads as low-effort bulk mail.',
		});
	}

	return hits;
}

/**
 * Score an email for spam signals. Deterministic: identical input → identical
 * report. The score is the capped sum of rule weights; the verdict is derived
 * from {@link SPAM_WARN_THRESHOLD} / {@link SPAM_FAIL_THRESHOLD}.
 */
export function scoreSpam(email: DeliverabilityEmail): SpamScoreReport {
	const hits = collectHits(email);
	const rawScore = hits.reduce((total, hit) => total + hit.points, 0);
	const score = Math.min(rawScore, SPAM_SCORE_MAX);
	const findings: Finding[] = hits.map((hit) => ({
		code: hit.code,
		severity: score >= SPAM_FAIL_THRESHOLD ? 'fail' : 'warn',
		message: hit.message,
	}));

	const verdict: Verdict =
		score >= SPAM_FAIL_THRESHOLD ? 'fail' : score >= SPAM_WARN_THRESHOLD ? 'warn' : 'pass';

	return { score, verdict, findings };
}

/** Normalize a raw spam score into the [0,1] range a `score` hook reports. */
export function normalizeSpamScore(score: number): number {
	if (!Number.isFinite(score) || score <= 0) return 0;
	return Math.min(score, SPAM_SCORE_MAX) / SPAM_SCORE_MAX;
}
