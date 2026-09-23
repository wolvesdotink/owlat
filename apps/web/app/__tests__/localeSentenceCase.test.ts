import { describe, expect, it } from 'vitest';
import en from '~~/i18n/locales/en.json';
import uiEn from '@owlat/ui/i18n/locales/en.json';

/**
 * UI copy uses sentence case: "Save changes", not "Save Changes".
 *
 * Only the first word of a label is capitalised, plus proper nouns, product
 * names and acronyms. This scan looks at short English strings (2–5 words,
 * no sentence punctuation), which is where headings, buttons and labels live,
 * and flags any later word that starts with a capital letter and is not on
 * the proper-noun list below.
 *
 * A word right after a separator (— · → | : and the {chevron} slot) starts a
 * new segment, as in "Settings → Domains" or "Delete {count} contact | Delete
 * {count} contacts", so it may keep its capital.
 *
 * If this test fails on a new string, write it in sentence case. If the
 * capitalised word really is a name, add it to PROPER_NOUNS.
 */

type Catalog = { [key: string]: string | Catalog };

function flatten(catalog: Catalog, prefix = ''): Map<string, string> {
	const flat = new Map<string, string>();
	for (const [key, value] of Object.entries(catalog)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (typeof value === 'string') {
			flat.set(path, value);
		} else {
			for (const [nested, message] of flatten(value, path)) flat.set(nested, message);
		}
	}
	return flat;
}

/** Names that keep their capital anywhere in a label. */
const PROPER_NOUNS = new Set([
	// Owlat surfaces that are named things
	'Owlat',
	'Postbox',
	'Answer', // the Answer queue
	'Inbox', // Postbox folder names
	'Spam',
	'Today', // page names
	'Features',
	// Mail headers
	'From',
	// Languages
	'English',
	'German',
	// Companies, products and services
	'Acme',
	'Amazon',
	'Anthropic',
	'Apple',
	'Beijing',
	'Claude',
	'Convex',
	'Docker',
	'Emailit',
	'Gemini',
	'Gmail',
	'Google',
	'Hotmail',
	'Jev',
	'Mailchimp',
	'Mandrill',
	'Meta',
	'Microsoft',
	'Outlook',
	'Postmaster',
	'Resend',
	'Stripe',
	'Thunderbird',
	'Twilio',
	'Yahoo',
	// Fonts
	'Courier',
	'Neue',
	'New',
	'Roman',
	'Times',
	// Timezone and place names
	'Berlin',
	'Canada',
	'Central',
	'Delhi',
	'Eastern',
	'Frankfurt',
	'Geneva',
	'Kong',
	'Milan',
	'Mountain',
	'Mumbai',
	'Pacific',
	'Paris',
	'Rome',
	'Shanghai',
	'Zealand',
	'Zurich',
	// Keys and legal terms
	'Act',
	'Esc',
	'I',
]);

/** Multi-word product names whose later words are part of the name. */
const PROPER_PHRASES = [
	'Google Workspace',
	'Mailchimp Transactional',
	'Mailchimp Marketing',
	'Migrate from Mailchimp',
	'Sealed mail',
	'Web Key Directory',
	'iCloud Mail',
	'iPhone Mail',
	'Yahoo Mail',
	'Apple Mail',
	'WhatsApp Business',
	'Times New Roman',
	'Courier New',
];

/** Keys whose values are example data or names, not UI copy. */
const IGNORED_KEYS = [
	/Placeholder/, // "e.g., Weekly Newsletter" — example names a user might type
	/\.labelNestingHint$/, // "Use Work/Clients/Acme to nest." — an example path
	/\.timezones\./,
	/^imprint\.representative\./,
	// Links that name another screen or button by its label.
	/\.enableLink$/,
	/\.appSenderHintLink$/,
	/\.previewUnavailable$/,
];

const SEPARATORS = new Set(['—', '–', '-', '·', '→', '|', '/', '+', '−']);

function titleCaseWords(message: string): string[] {
	let text = message;
	// A proper phrase counts as one lowercase word, so its capitals pass.
	for (const phrase of PROPER_PHRASES) text = text.split(phrase).join('x');
	// {chevron} separates segments, and {prefix} carries a breadcrumb path.
	text = text.replace(/\{(chevron|prefix)\}/g, ' → ').replace(/\{[^}]*\}/g, ' x ');
	const tokens = text.split(/\s+/).filter(Boolean);
	const words = tokens.filter((token) => /[A-Za-z]/.test(token) && !SEPARATORS.has(token));
	if (words.length < 2 || words.length > 5) return [];
	if (/[.!?]\s/.test(message)) return [];

	const offenders: string[] = [];
	let previous = '';
	for (const [index, token] of tokens.entries()) {
		const startsSegment = index === 0 || SEPARATORS.has(previous) || previous.endsWith(':');
		previous = token;
		if (startsSegment) continue;
		for (const part of token.split(/[-/]/)) {
			const word = part.replace(/^[("“'‘]+|[)"”'’,.!?:;…]+$/g, '').replace(/['’]s$/, '');
			if (!/^[A-Z][a-z]+$/.test(word)) continue; // lowercase, acronym or camelCase
			if (PROPER_NOUNS.has(word)) continue;
			offenders.push(word);
		}
	}
	return offenders;
}

function findTitleCase(catalog: Catalog): string[] {
	const found: string[] = [];
	for (const [key, message] of flatten(catalog)) {
		if (IGNORED_KEYS.some((pattern) => pattern.test(key))) continue;
		const offenders = titleCaseWords(message);
		if (offenders.length > 0) found.push(`${key}: "${message}" (${offenders.join(', ')})`);
	}
	return found;
}

describe('UI copy uses sentence case', () => {
	it('flags Title Case labels and leaves sentence case alone', () => {
		expect(titleCaseWords('Save Changes')).toEqual(['Changes']);
		expect(titleCaseWords('Add Your First Domain')).toEqual(['Your', 'First', 'Domain']);
		expect(titleCaseWords('Save changes')).toEqual([]);
		expect(titleCaseWords('Connect Mailchimp Transactional')).toEqual([]);
		expect(titleCaseWords('Create API key')).toEqual([]);
		expect(titleCaseWords('Settings → Domains → Receiving')).toEqual([]);
		expect(titleCaseWords('Delete {count} contact | Delete {count} contacts')).toEqual([]);
		expect(titleCaseWords('Account settings — Owlat')).toEqual([]);
	});

	it('apps/web en.json has no Title Case labels', () => {
		expect(findTitleCase(en as Catalog)).toEqual([]);
	});

	it('packages/ui en.json has no Title Case labels', () => {
		expect(findTitleCase(uiEn as Catalog)).toEqual([]);
	});
});
