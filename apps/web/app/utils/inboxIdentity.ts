/**
 * Inbox identity — the short name and colour every inbox wears wherever a reply
 * can start (sidebar, Today, Answer queue, reader, composer "Send as …").
 *
 * Colours come from the chart kit's categorical tokens (`--chart-cat-1..4`),
 * which are defined per colour mode and already validated for colour-blind
 * separation. There are four; a fifth inbox falls back to a neutral chip. The
 * chip always pairs the colour with the name, so identity never depends on
 * colour vision alone.
 *
 * Pure (no Vue, no Convex) so the slot assignment stays unit-testable.
 */

export const INBOX_COLOR_SLOTS = 4;

/** Tailwind classes for each slot's swatch (index = slot). */
export const INBOX_SLOT_SWATCH: readonly string[] = [
	'bg-chart-cat-1',
	'bg-chart-cat-4',
	'bg-chart-cat-3',
	'bg-chart-cat-2',
];

/** The row `mail.mailbox.queries.accessible` returns for one inbox. */
export interface AccessibleInboxRow {
	mailboxId: string;
	label: string;
	address: string;
	scope: 'personal' | 'shared';
	colorSlot: number | null;
	unread: number;
}

export interface InboxIdentity<Id extends string = string> {
	mailboxId: Id;
	/** Short display name: the inbox's own name, else its address's local part. */
	name: string;
	address: string;
	scope: 'personal' | 'shared';
	/** Swatch slot, or null for the neutral fallback past the fourth inbox. */
	slot: number | null;
	unread: number;
}

/** "support@northwind.studio" → "Support". */
export function nameFromAddress(address: string): string {
	const local = address.split('@', 1)[0] ?? address;
	const words = local.split(/[._+-]+/).filter(Boolean);
	if (words.length === 0) return address;
	return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * The chip's short name. A shared inbox keeps its own name ("Support"); a
 * personal mailbox named after its owner ("Ada Marlow") reads as the first
 * name, which is how people refer to their own inbox next to a team's.
 */
function shortName(row: AccessibleInboxRow): string {
	const label = row.label.trim();
	if (label.length === 0 || label.toLowerCase() === row.address.toLowerCase()) {
		return nameFromAddress(row.address);
	}
	if (row.scope === 'personal') return label.split(/\s+/, 1)[0] ?? label;
	return label;
}

/**
 * Order inboxes (personal first, then shared, each alphabetical — the same
 * order the mailbox switcher uses) and give each a stable swatch: an explicit
 * `colorSlot` wins, the first personal inbox takes slot 0, everyone else takes
 * the lowest free slot in order.
 */
export function resolveInboxIdentities<Id extends string>(
	rows: ReadonlyArray<AccessibleInboxRow & { mailboxId: Id }>
): InboxIdentity<Id>[] {
	const ordered = [...rows].sort((a, b) => {
		if (a.scope !== b.scope) return a.scope === 'personal' ? -1 : 1;
		return shortName(a).localeCompare(shortName(b));
	});
	const taken = new Set<number>();
	for (const row of ordered) {
		if (row.colorSlot !== null && row.colorSlot >= 0 && row.colorSlot < INBOX_COLOR_SLOTS) {
			taken.add(row.colorSlot);
		}
	}
	const nextFree = (): number | null => {
		for (let slot = 0; slot < INBOX_COLOR_SLOTS; slot++) {
			if (!taken.has(slot)) {
				taken.add(slot);
				return slot;
			}
		}
		return null;
	};
	return ordered.map((row) => {
		const explicit =
			row.colorSlot !== null && row.colorSlot >= 0 && row.colorSlot < INBOX_COLOR_SLOTS
				? row.colorSlot
				: null;
		return {
			mailboxId: row.mailboxId,
			name: shortName(row),
			address: row.address,
			scope: row.scope,
			slot: explicit ?? nextFree(),
			unread: row.unread,
		};
	});
}
