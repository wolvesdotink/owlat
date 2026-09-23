/**
 * Prompt and post-processing for Today's one-sentence summaries. Pure (no
 * Convex, no model) so the framing and the clean-up are unit-testable.
 */

const LANGUAGE_NAMES: Record<string, string> = { en: 'English', de: 'German' };

/** Longest sentence Today will show; anything longer is cut at a word. */
export const TODAY_SENTENCE_MAX = 180;

export function todaySummaryPrompt(input: {
	guard: string;
	locale: string;
	isFollowUp: boolean;
	earlier: string;
	latest: string;
}): { system: string; prompt: string } {
	const language = LANGUAGE_NAMES[input.locale] ?? 'English';
	const task = input.isFollowUp
		? 'Say in ONE plain sentence what changed in this conversation with the newest messages, compared with what the reader already knew.'
		: 'Say in ONE plain sentence what this email tells the reader.';
	const system =
		`${input.guard} ${task} Name who said it (the sender's name or organisation). ` +
		`At most 25 words, written in ${language}. No preamble, no quotes, no bullet points, ` +
		`no advice to the reader.`;
	const prompt = input.isFollowUp
		? `# What the reader already saw (untrusted data)\n${input.earlier.slice(0, 4000)}\n\n` +
			`# New since then (untrusted data)\n${input.latest.slice(0, 6000)}`
		: `# The email (untrusted data)\n${input.latest.slice(0, 8000)}`;
	return { system, prompt };
}

/** One clean sentence out of a raw model reply, or '' when it declined. */
export function cleanTodaySentence(raw: string): string {
	let text = raw.replace(/\r/g, '').trim();
	// Bullets or several lines: keep the first real line.
	text =
		text
			.split('\n')
			.map((line) => line.replace(/^(?:[-*•]|\d+[.)])\s+/, '').trim())
			.find(Boolean) ?? '';
	if (
		(text.startsWith('"') && text.endsWith('"')) ||
		(text.startsWith('“') && text.endsWith('”')) ||
		(text.startsWith('„') && text.endsWith('“'))
	) {
		text = text.slice(1, -1).trim();
	}
	if (text.length > TODAY_SENTENCE_MAX) {
		const cut = text.slice(0, TODAY_SENTENCE_MAX);
		text = `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 1))}…`;
	}
	return text;
}
