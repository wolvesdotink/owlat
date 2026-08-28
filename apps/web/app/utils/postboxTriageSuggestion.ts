/**
 * Rule suggestions from observed triage (idea 27) — the pure half.
 *
 * The server decides WHETHER to offer; this module decides how the offer reads.
 * A module-scope registry per verb, carrying message KEYS rather than sentences
 * (the i18n registry convention) so the strip resolves them at the render
 * boundary and a locale switch relabels in place.
 */

export type PostboxTriageVerb = 'archive' | 'trash' | 'spam';

interface TriageVerbCopy {
	/** "You archive everything from …" — the observation. */
	promptKey: string;
	/** The accept button ("Always archive it"). */
	acceptKey: string;
	/** The name the created rule is saved under. */
	ruleNameKey: string;
	icon: string;
}

const VERB_COPY: Readonly<Record<PostboxTriageVerb, TriageVerbCopy>> = {
	archive: {
		promptKey: 'components.postbox.postboxTriageSuggestion.prompt.archive',
		acceptKey: 'components.postbox.postboxTriageSuggestion.accept.archive',
		ruleNameKey: 'components.postbox.postboxTriageSuggestion.ruleName.archive',
		icon: 'lucide:archive',
	},
	trash: {
		promptKey: 'components.postbox.postboxTriageSuggestion.prompt.trash',
		acceptKey: 'components.postbox.postboxTriageSuggestion.accept.trash',
		ruleNameKey: 'components.postbox.postboxTriageSuggestion.ruleName.trash',
		icon: 'lucide:trash-2',
	},
	spam: {
		promptKey: 'components.postbox.postboxTriageSuggestion.prompt.spam',
		acceptKey: 'components.postbox.postboxTriageSuggestion.accept.spam',
		ruleNameKey: 'components.postbox.postboxTriageSuggestion.ruleName.spam',
		icon: 'lucide:shield-alert',
	},
};

/** Copy for one verb, or null for a value the server does not offer. */
export function postboxTriageVerbCopy(verb: string): TriageVerbCopy | null {
	return VERB_COPY[verb as PostboxTriageVerb] ?? null;
}

/**
 * Deep link to the rule a suggestion created, in the Filters preferences page.
 *
 * "A visible link to the created rule" is what makes accepting reversible in the
 * user's own terms: the rule is an ordinary filter from that moment, and this is
 * where they see, edit or delete it.
 */
export function postboxFilterRuleLink(filterId: string): string {
	return `/dashboard/preferences/filters?openFilter=${encodeURIComponent(filterId)}`;
}
