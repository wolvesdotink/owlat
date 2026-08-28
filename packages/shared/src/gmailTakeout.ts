/**
 * Gmail Takeout's `X-Gmail-Labels` header → Owlat folders, flags and labels.
 *
 * A Takeout mbox is a FLAT archive: every message in the account appears once,
 * in one file, and the only record of where it lived is a non-standard header
 * Gmail adds on export:
 *
 *     X-Gmail-Labels: Inbox,Unread,Important,Work/Invoices,Category Updates
 *
 * That single header mixes four different things — the folder the message was
 * in, its read/star flags, Gmail's own classification buckets, and the user's
 * real labels — so importing it verbatim as labels would bury a mailbox under
 * "Unread" and "Category Promotions" pseudo-labels. {@link routeGmailLabels}
 * pulls the four apart.
 *
 * Read-state note: Gmail marks the UNREAD state, not the read one. An absent
 * `Unread` label therefore means "read", which is why {@link routeGmailLabels}
 * defaults `flagSeen` to true — a Takeout import of a mostly-read archive must
 * not land as thousands of unread messages.
 */

/** Owlat system folder a Takeout message can land in. */
export type GmailTakeoutFolderRole = 'inbox' | 'sent' | 'drafts' | 'trash' | 'spam' | 'archive';

/**
 * Gmail system labels that name a FOLDER, most-specific first: a message
 * labelled both `Inbox` and `Trash` is in the trash.
 *
 * `Inbox` beats `Sent` because Gmail files a self-addressed message under both
 * and Owlat has one folder per message: a message that is still in the inbox
 * may need an answer, and losing it into Sent would hide it.
 */
const FOLDER_LABELS: ReadonlyArray<readonly [string, GmailTakeoutFolderRole]> = [
	['trash', 'trash'],
	['spam', 'spam'],
	['draft', 'drafts'],
	['inbox', 'inbox'],
	['sent', 'sent'],
];

/**
 * Gmail system labels that are NOT user labels: flags, folders, classification
 * buckets and the chat marker. Everything outside this set (and outside the
 * `Category …` prefix) is a label the user actually made.
 */
const SYSTEM_LABELS = new Set([
	'inbox',
	'sent',
	'draft',
	'drafts',
	'trash',
	'spam',
	'archived',
	'unread',
	'starred',
	'important',
	'opened',
	'chat',
	'ims',
]);

/** Gmail's own tabs. Owlat has smart categories of its own; these are dropped. */
const CATEGORY_PREFIX = 'category ';

/** Where one Takeout message belongs once its label header is untangled. */
export interface GmailTakeoutRouting {
	folderRole: GmailTakeoutFolderRole;
	/** User labels only, in header order, deduped, original casing preserved. */
	labelNames: string[];
	flagSeen: boolean;
	flagFlagged: boolean;
	/** Gmail's `Important` marker, kept separate — it is a signal, not a label. */
	isImportant: boolean;
}

/**
 * Split an `X-Gmail-Labels` value into label names.
 *
 * The header is comma-separated with NO escaping, except that Gmail quotes a
 * label containing a comma. Both forms appear in the same archive, so the split
 * has to respect quotes rather than being a `split(',')`.
 */
export function parseGmailLabelsHeader(value: string | undefined): string[] {
	if (!value) return [];
	const labels: string[] = [];
	let current = '';
	let quoted = false;
	for (const char of value) {
		if (char === '"') {
			quoted = !quoted;
			continue;
		}
		if (char === ',' && !quoted) {
			labels.push(current);
			current = '';
			continue;
		}
		current += char;
	}
	labels.push(current);
	return labels.map((label) => label.trim()).filter(Boolean);
}

/** Untangle a Takeout label list into a folder, flags and real user labels. */
export function routeGmailLabels(labels: readonly string[]): GmailTakeoutRouting {
	const lowered = new Set(labels.map((label) => label.toLowerCase()));
	const folderRole =
		FOLDER_LABELS.find(([label]) => lowered.has(label))?.[1] ??
		// No folder label at all is Gmail's "All Mail" state: archived, not inbox.
		'archive';

	const labelNames: string[] = [];
	const seen = new Set<string>();
	for (const label of labels) {
		const key = label.toLowerCase();
		if (SYSTEM_LABELS.has(key) || key.startsWith(CATEGORY_PREFIX) || seen.has(key)) continue;
		seen.add(key);
		labelNames.push(label);
	}

	return {
		folderRole,
		labelNames,
		// Gmail records UNREAD; its absence is the read state.
		flagSeen: !lowered.has('unread'),
		flagFlagged: lowered.has('starred'),
		isImportant: lowered.has('important'),
	};
}
