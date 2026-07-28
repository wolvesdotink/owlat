/**
 * Seed mailbox placement — FOLDER CLASSIFICATION (the pure decision core, D15).
 *
 * A domain sibling of `seedPlacement.ts` (CONVENTIONS.md's ~500 LOC split
 * guideline): given the NAME of the remote folder an IMAP poller found a probe
 * in, plus the folder's RFC 6154 SPECIAL-USE attribute when the server offered
 * one — and nothing else, never its contents — decide what that means.
 *
 * The FLAG decides first and the name is the fallback, and that order is the
 * point. Provider folder naming is the whole difficulty: Gmail nests under
 * `[Gmail]/`, Outlook says `Junk Email`, Yahoo says `Bulk Mail`, a Gmail tab is
 * a LABEL rather than a folder, and consumer providers localize the Junk folder
 * per account language. A name table can never be complete, and an unrecognised
 * name falls through to `category`, which counts as REACHED — so every gap in
 * the table reads a spam-filed probe as healthy and moves gate 5 toward `pass`.
 * `\Junk` is the server telling us the answer in no language at all.
 *
 * Re-exported from `seedPlacement.ts`, which stays the single import surface.
 *
 * No clock reads, no I/O: every input is a parameter.
 */

import type { DestinationProviderKey } from './deliverabilityRouting';

export const SEED_PLACEMENTS = ['inbox', 'category', 'spam', 'deleted', 'missing'] as const;
export type SeedPlacement = (typeof SEED_PLACEMENTS)[number];

/**
 * The placements that mean "the message survived to somewhere the recipient
 * could plausibly read it". Everything else — spam, an auto-deleted probe, or
 * one that could not be found at all — is NOT reached.
 */
export function isSeedPlacementReached(placement: SeedPlacement): boolean {
	return placement === 'inbox' || placement === 'category';
}

export interface SeedFolderClassification {
	placement: SeedPlacement;
	/**
	 * Present only for `category`: the Gmail tab (Promotions, Updates, …) or,
	 * for any other provider, the non-inbox non-spam folder the probe was
	 * filtered into. Folder NAMES are metadata; mailbox CONTENTS are never
	 * carried by this module.
	 */
	categoryLabel?: string;
}

/**
 * Strip the provider-specific folder-hierarchy prefixes so `[Gmail]/Spam`,
 * `INBOX.Junk` and `Junk E-mail` all normalize to a comparable leaf name.
 *
 * Every folder-name SET below is built by mapping its literals through this
 * same function, so a normalization rule can never silently make an entry
 * unreachable (the `Junk E-mail` → `junk e mail` trap).
 */
function normalizeFolderName(folderName: string): string {
	let name = folderName.trim();
	// Gmail's IMAP namespace: "[Gmail]/Spam", "[Google Mail]/Spam".
	name = name.replace(/^\[(?:gmail|google mail)\]\//i, '');
	// Dovecot/Courier style INBOX-rooted hierarchies: "INBOX.Junk", "INBOX/Junk".
	name = name.replace(/^inbox[./]/i, '');
	// Gmail category LABELS arrive as "CATEGORY_PROMOTIONS".
	name = name.replace(/^category[_/]/i, '');
	return (
		name
			.toLowerCase()
			// Diacritics are folded so ONE localized spelling per language is enough
			// in the tables below: an operator's IMAP server may or may not send
			// `Courrier indésirable` fully composed, and either way it has to match.
			.normalize('NFD')
			.replace(/[\u0300-\u036f]/gu, '')
			.replace(/[_-]+/g, ' ')
			.trim()
	);
}

function normalizedFolderSet(names: readonly string[]): ReadonlySet<string> {
	return new Set(names.map(normalizeFolderName));
}

/**
 * Spam/junk folder names across the providers an operator can realistically
 * seed — the FALLBACK, used only when the server offered no special-use flag.
 *
 * A name table can never be complete: consumer providers localize the Junk
 * folder per account language, so the list carries the common European
 * spellings the card's "plus regional providers" implies alongside the English
 * ones. The flag is what makes the classification sound; this is what catches
 * the servers that do not advertise one.
 */
const SPAM_FOLDER_NAMES = normalizedFolderSet([
	'Spam',
	'Junk',
	'Junk E-mail',
	'Junk Email',
	'JunkMail',
	'Junk Mail',
	'Spam Mail',
	'Bulk',
	'Bulk Mail',
	'Unwanted',
	'Quarantine',
	// Localized Junk/Spam folder names. Outlook.com, Yahoo and the regional
	// providers name this folder in the account's own language.
	'Courrier indésirable', // fr
	'Indésirables',
	'Posta indesiderata', // it
	'Correo no deseado', // es
	'Lixo eletrônico', // pt
	'Spamverdacht', // de
	'Ongewenste e-mail', // nl
	'Ongewenst',
	'Skräppost', // sv
	'Uønsket e-post', // nb
	'Uonsket e-post',
	'Roskaposti', // fi
	'Nevyžádaná pošta', // cs
	'Wiadomości-śmieci', // pl
	'Спам', // ru / uk / bg
	'迷惑メール', // ja
	'垃圾邮件', // zh-Hans
	'垃圾郵件', // zh-Hant
	'스팸편지함', // ko
]);

/**
 * Deleted-mail folders. A probe the provider swept straight into the bin has
 * NOT reached the mailbox in any useful sense — treating it as a filtered
 * "category" would read as healthy, which is precisely backwards.
 */
const DELETED_FOLDER_NAMES = normalizedFolderSet([
	'Trash',
	'Deleted',
	'Deleted Items',
	'Deleted Messages',
	'Bin',
]);

/** Gmail tab labels, in the two shapes IMAP surfaces them. */
const GMAIL_CATEGORY_LABELS: Record<string, string> = {
	promotions: 'Promotions',
	updates: 'Updates',
	forums: 'Forums',
	social: 'Social',
	personal: 'Personal',
};

/**
 * RFC 6154 SPECIAL-USE attributes, which are how a folder says what it IS
 * independently of what it is CALLED. `\Junk` and `\Trash` are the two that
 * decide a placement; the rest carry no verdict here.
 *
 * These are compared case-insensitively with the leading backslash optional,
 * because that is how they arrive off different servers and clients.
 */
const SPECIAL_USE_JUNK = 'junk';
const SPECIAL_USE_TRASH = 'trash';

function normalizeSpecialUse(flag: string | null | undefined): string | undefined {
	if (flag === null || flag === undefined) return undefined;
	const trimmed = flag.trim().replace(/^\\+/, '').toLowerCase();
	return trimmed === '' ? undefined : trimmed;
}

/**
 * Classify one probe observation.
 *
 * `folderName` is `null`/`undefined` when the poller walked every folder of the
 * seed mailbox and did not find the probe at all — MISSING, the most alarming
 * outcome and the one no other signal in the system surfaces.
 *
 * `specialUse` is the folder's RFC 6154 attribute when the server advertised
 * one, and it DECIDES ahead of the name table. Names alone cannot carry this:
 * consumer providers localize the Junk folder per account language, and an
 * unrecognised name falls through to `category`, which counts as REACHED — so
 * every gap in the table reads a spam-filed probe as healthy and moves gate 5
 * toward `pass`. The flag is the server telling us the answer; the names stay
 * as the fallback for servers that advertise nothing.
 *
 * An unrecognised, non-spam folder is reported as `category`: the message was
 * accepted but filtered away from the inbox, which is the same operational
 * meaning as a Gmail tab.
 */
export function classifySeedFolder(
	folderName: string | null | undefined,
	provider: DestinationProviderKey,
	specialUse?: string | null
): SeedFolderClassification {
	if (folderName === null || folderName === undefined || folderName.trim() === '') {
		return { placement: 'missing' };
	}

	// The server's own answer, ahead of any guess made from the name.
	const attribute = normalizeSpecialUse(specialUse);
	if (attribute === SPECIAL_USE_JUNK) return { placement: 'spam' };
	if (attribute === SPECIAL_USE_TRASH) return { placement: 'deleted' };

	const normalized = normalizeFolderName(folderName);
	if (normalized === 'inbox') {
		return { placement: 'inbox' };
	}
	if (SPAM_FOLDER_NAMES.has(normalized)) {
		return { placement: 'spam' };
	}
	if (DELETED_FOLDER_NAMES.has(normalized)) {
		return { placement: 'deleted' };
	}
	if (provider === 'gmail') {
		const label = GMAIL_CATEGORY_LABELS[normalized];
		if (label !== undefined) {
			return label === 'Personal'
				? { placement: 'inbox' }
				: { placement: 'category', categoryLabel: label };
		}
	}
	// Anything left — including a name that normalizes to NOTHING (`___`, `--`,
	// a bare `[Gmail]/`) — is an unknown, non-inbox folder. Reading a degenerate
	// remainder as `inbox` would claim the probe reached the recipient on the
	// strength of a name we could not parse.
	return { placement: 'category', categoryLabel: folderName.trim() };
}
