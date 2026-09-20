/**
 * Pick the reader's-language rendering of a clarification question.
 *
 * The backend stores every question with canonical English `text` / `options`
 * and, when the localization pass succeeded, one `translations` entry per
 * other interface locale (see apps/api/convex/inbox/clarificationLocalize.ts).
 * Both clarification surfaces (the team-inbox thread page and the Postbox
 * "Needs your input" card) resolve the copy through this one helper, so the
 * fallback rule lives in a single place: the entry for the current locale,
 * else the canonical copy.
 *
 * Whatever is shown, the chip VALUE the user submits is always the canonical
 * English option at the same index — the answer feeds the `[CONFIRMED BY
 * OWNER]` block and answer-memory, which match on the canonical text.
 * `canonicalOption` maps a displayed option back to its canonical value.
 */

export interface LocalizableClarificationQuestion {
	text: string;
	options?: string[] | undefined;
	translations?: { locale: string; text: string; options?: string[] | undefined }[] | undefined;
}

export interface LocalizedQuestionCopy {
	text: string;
	options: string[];
}

/** The copy to display for `question` in `locale` (falls back to canonical). */
export function localizedQuestionCopy(
	question: LocalizableClarificationQuestion,
	locale: string
): LocalizedQuestionCopy {
	const canonicalOptions = question.options ?? [];
	const match = question.translations?.find((t) => t.locale === locale.toLowerCase());
	if (!match) return { text: question.text, options: canonicalOptions };
	const options =
		match.options && match.options.length === canonicalOptions.length
			? match.options
			: canonicalOptions;
	return { text: match.text, options };
}

/**
 * Map a displayed (possibly translated) option back to the canonical English
 * value that is persisted as the answer. Free text passes through unchanged.
 */
export function canonicalOption(
	question: LocalizableClarificationQuestion,
	locale: string,
	displayed: string
): string {
	const shown = localizedQuestionCopy(question, locale).options;
	const index = shown.indexOf(displayed);
	if (index < 0) return displayed;
	return question.options?.[index] ?? displayed;
}

/** One-line summary in the reader's language, else English, else nothing. */
export function localizedSummary(
	summary: Record<string, string> | undefined,
	locale: string
): string | undefined {
	if (!summary) return undefined;
	return summary[locale.toLowerCase()] ?? summary['en'] ?? Object.values(summary)[0];
}
