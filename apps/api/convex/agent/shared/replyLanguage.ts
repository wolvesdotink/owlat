/**
 * The one rule about reply language, shared by the primary draft prompt and
 * the alternative-options prompt (agent/shared/draftService.ts): the reply is
 * written in the language the sender wrote in. Split out to keep the draft
 * service under the ~500 LOC file-size ratchet. See ADR-0061.
 */

/** Human-readable names for the language codes the classifier commonly emits. */
const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
	en: 'English',
	de: 'German',
	fr: 'French',
	es: 'Spanish',
	it: 'Italian',
	pt: 'Portuguese',
	nl: 'Dutch',
	pl: 'Polish',
	sv: 'Swedish',
	da: 'Danish',
	fi: 'Finnish',
	no: 'Norwegian',
	cs: 'Czech',
	tr: 'Turkish',
	ru: 'Russian',
	uk: 'Ukrainian',
	ja: 'Japanese',
	zh: 'Chinese',
	ko: 'Korean',
	ar: 'Arabic',
};

/**
 * The one rule about language: the reply is written in the language the
 * sender wrote in, never in the language of these instructions or of the
 * organisation's tone/signature guidance. When the classifier detected the
 * language it is named explicitly; otherwise the model matches the inbound.
 * Pure + exported for tests.
 */
export function buildReplyLanguageInstruction(replyLanguage: string | undefined): string {
	const base =
		'Write the ENTIRE reply in the language the sender wrote their email in, even though ' +
		'these instructions are in English. Translate any signature or standing wording into that language rather than mixing languages';
	if (!replyLanguage) return `${base}.`;
	const code = replyLanguage.toLowerCase();
	const name = LANGUAGE_NAMES[code.split('-')[0] ?? code];
	return `${base}. The sender wrote in ${name ? `${name} (${code})` : `language "${code}"`}; write the whole reply in that language.`;
}
