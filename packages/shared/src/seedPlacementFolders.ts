/**
 * Seed mailbox placement — FOLDER CLASSIFICATION (the pure decision core, D15).
 *
 * A domain sibling of `seedPlacement.ts` (CONVENTIONS.md's ~500 LOC split
 * guideline): given the NAME of the remote folder an IMAP poller found a probe
 * in — and nothing else, never its contents — decide what that means. Provider
 * folder naming is the whole difficulty: Gmail nests under `[Gmail]/`, Outlook
 * says `Junk Email`, Yahoo says `Bulk Mail`, and a Gmail tab is a LABEL, not a
 * folder.
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
	return name.toLowerCase().replace(/[_-]+/g, ' ').trim();
}

function normalizedFolderSet(names: readonly string[]): ReadonlySet<string> {
	return new Set(names.map(normalizeFolderName));
}

/** Spam/junk folder names across the providers an operator can realistically seed. */
const SPAM_FOLDER_NAMES = normalizedFolderSet([
	'Spam',
	'Junk',
	'Junk E-mail',
	'Junk Email',
	'JunkMail',
	'Bulk',
	'Bulk Mail',
	'Unwanted',
	'Quarantine',
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
 * Classify one probe observation.
 *
 * `folderName` is `null`/`undefined` when the poller walked every folder of the
 * seed mailbox and did not find the probe at all — MISSING, the most alarming
 * outcome and the one no other signal in the system surfaces.
 *
 * An unrecognised, non-spam folder is reported as `category`: the message was
 * accepted but filtered away from the inbox, which is the same operational
 * meaning as a Gmail tab.
 */
export function classifySeedFolder(
	folderName: string | null | undefined,
	provider: DestinationProviderKey
): SeedFolderClassification {
	if (folderName === null || folderName === undefined || folderName.trim() === '') {
		return { placement: 'missing' };
	}

	const normalized = normalizeFolderName(folderName);
	if (normalized === '' || normalized === 'inbox') {
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
	return { placement: 'category', categoryLabel: folderName.trim() };
}
