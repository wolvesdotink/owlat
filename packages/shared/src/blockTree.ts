/**
 * The child contract of the Block tree: which Blocks a composite Block holds,
 * and where in its content they live.
 *
 * - `columns` holds a grid: one list per column (`content.columns`).
 * - `container` and `hero` hold one list (`content.items`).
 * - `accordion` holds one list per section (`content.sections[n].items`).
 *
 * Every traversal of the tree goes through these helpers: the builder's ID
 * renewal and nested editing, the translation row extraction and the overlay
 * merge. A new child-bearing Block type is added to `CHILD_SLOTS` once instead
 * of to a type switch in each of them. Which child types a composite accepts
 * (placement) stays with the block registries.
 */

import { jsonClone } from './utils/jsonClone';

/** A root Block or a nested Block item. Every level of the tree has this shape. */
export interface BlockTreeNode {
	id: string;
	type: string;
	content: object;
}

type Content = Record<string, unknown>;

interface ChildSlot {
	/** The child lists in document order. These are the stored arrays, not copies. */
	lists(content: Content): unknown[][];
	/** A shallow copy of `content` holding `lists` in place of its current child lists. */
	withLists(content: Content, lists: unknown[][]): Content;
	/** The non-Block entries the content owns that carry their own id (accordion sections). */
	entries?(content: Content): Content[];
}

const isRecord = (value: unknown): value is Content =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const itemsSlot: ChildSlot = {
	lists: (content) => (Array.isArray(content['items']) ? [content['items']] : []),
	withLists: (content, lists) => (lists.length > 0 ? { ...content, items: lists[0] } : content),
};

const sectionsOf = (content: Content): unknown[] =>
	Array.isArray(content['sections']) ? content['sections'] : [];

const CHILD_SLOTS: Readonly<Record<string, ChildSlot>> = {
	columns: {
		lists: (content) =>
			Array.isArray(content['columns'])
				? content['columns'].map((column) => (Array.isArray(column) ? column : []))
				: [],
		withLists: (content, lists) =>
			Array.isArray(content['columns']) ? { ...content, columns: lists } : content,
	},
	container: itemsSlot,
	hero: itemsSlot,
	accordion: {
		lists: (content) =>
			sectionsOf(content).map((section) =>
				isRecord(section) && Array.isArray(section['items']) ? section['items'] : []
			),
		withLists: (content, lists) => {
			if (!Array.isArray(content['sections'])) return content;
			return {
				...content,
				sections: content['sections'].map((section, index) =>
					isRecord(section) && Array.isArray(section['items'])
						? { ...section, items: lists[index] }
						: section
				),
			};
		},
		entries: (content) => sectionsOf(content).filter(isRecord),
	},
};

const isNode = (value: unknown): value is BlockTreeNode =>
	isRecord(value) && typeof value['id'] === 'string' && typeof value['type'] === 'string';

/**
 * The child slot of a Block type; undefined for a leaf. Only the table's own
 * keys count: a stored `type` such as `constructor` must not find an inherited
 * `Object.prototype` member and be walked as a composite.
 */
const slotFor = (type: string): ChildSlot | undefined =>
	Object.prototype.hasOwnProperty.call(CHILD_SLOTS, type) ? CHILD_SLOTS[type] : undefined;

const slotOf = (node: BlockTreeNode): { slot: ChildSlot; content: Content } | null => {
	const slot = slotFor(node.type);
	return slot && isRecord(node.content) ? { slot, content: node.content } : null;
};

/**
 * The child Block lists of `node`, in document order; empty for a leaf. The
 * arrays are the stored ones, so writing to them edits the tree in place.
 * Entries that are not Block-shaped (stored data is not trusted) are skipped.
 * Children are typed like their parent: nested items share the node shape.
 */
export function childBlockLists<N extends BlockTreeNode>(node: N): N[][] {
	const found = slotOf(node);
	if (!found) return [];
	return found.slot
		.lists(found.content)
		.map((list) => (list.every(isNode) ? list : list.filter(isNode)) as N[]);
}

/**
 * A copy of `node` whose child lists are replaced by `map(list, listIndex)`.
 * Nothing is mutated: the node, its content and each rebuilt list are new
 * objects, and children `map` returns unchanged keep their identity. A leaf
 * is returned as is.
 */
export function mapChildBlockLists<N extends BlockTreeNode>(
	node: N,
	map: (list: N[], listIndex: number) => N[]
): N {
	const found = slotOf(node);
	if (!found) return node;
	const lists = childBlockLists(node).map(map);
	return { ...node, content: found.slot.withLists(found.content, lists) };
}

/**
 * The entries `node` owns that are not Blocks but carry their own id
 * (accordion sections), in document order; empty for every other type. These
 * are the stored objects, so writing an entry's `id` edits the tree in place.
 * Their ids end up in the rendered email (an accordion section's toggle), so
 * they have to be unique across the document like Block ids.
 */
export function ownedEntries(node: BlockTreeNode): Array<Record<string, unknown>> {
	const found = slotOf(node);
	return found?.slot.entries?.(found.content) ?? [];
}

/**
 * Give `node` and every descendant a fresh id, in place. Call it on a deep
 * copy: a duplicated or re-inserted Block must not share any id with the
 * original, or edits and translation overlays keyed by a child id would reach
 * both copies.
 */
export function renewBlockTreeIds(node: BlockTreeNode, newId: () => string): void {
	node.id = newId();
	const found = slotOf(node);
	if (!found) return;
	for (const entry of found.slot.entries?.(found.content) ?? []) entry['id'] = newId();
	for (const list of childBlockLists(node)) {
		for (const child of list) renewBlockTreeIds(child, newId);
	}
}

/** How `normalizeBlockTreeIds` treats an id that an earlier Block or section already uses. */
export interface NormalizeBlockTreeIdsOptions {
	/**
	 * Also give a repeated id a fresh one, keeping the first occurrence in
	 * document order. The editor needs this: its canvas keys Blocks by id, and
	 * two Blocks with one id send it into a recursive update loop.
	 * Readers that only render leave repeated ids alone (the default), so a
	 * read never detaches a copy from the translation overlay it shares.
	 */
	renewRepeated?: boolean;
}

const usableId = (id: unknown): id is string => typeof id === 'string' && id !== '';

/**
 * Visit every Block-shaped entry in `entries` and below, in document order:
 * the Block, then the sections it owns, then its children. Unlike
 * `childBlockLists` this reaches entries without a usable id, so they can be
 * given one. Entries that are not an object with a string `type` are skipped.
 */
function forEachTreeEntry(
	entries: readonly unknown[],
	onBlock: (block: Content) => void,
	onSection: (section: Content) => void
): void {
	for (const entry of entries) {
		if (!isRecord(entry) || typeof entry['type'] !== 'string') continue;
		onBlock(entry);
		const slot = slotFor(entry['type']);
		const content = entry['content'];
		if (!slot || !isRecord(content)) continue;
		for (const section of slot.entries?.(content) ?? []) onSection(section);
		for (const list of slot.lists(content)) forEachTreeEntry(list, onBlock, onSection);
	}
}

/**
 * Walk the tree and report whether any id needs repair; with `write`, repair it
 * in place. Missing ids are filled in a first pass and repeated ids renewed in
 * a second, so a Block without an id gets the same id whether or not repeated
 * ids are renewed (the editor and the server render then agree on it).
 *
 * A fresh id is always the smallest `<prefix>-<n>` not in use, counted per
 * prefix. It then depends only on the ids in use, not on how many ids of the
 * other kind were filled before it, so filling first and renewing in a later
 * call (the editor: `parseStoredBlocks`, then the canvas renewal) gives the
 * same ids as one call doing both (the server's `repeatedBlockIdRenewals`).
 */
function repairTreeIds(
	roots: readonly unknown[],
	renewRepeated: boolean,
	write: boolean,
	onRenewBlock?: (from: string, to: string) => void
): boolean {
	const taken = new Set<string>();
	const collect = (entry: Content): void => {
		if (usableId(entry['id'])) taken.add(entry['id']);
	};
	forEachTreeEntry(roots, collect, collect);

	// Every `<prefix>-<n>` up to a prefix's counter is in use, so counting on
	// from it finds the smallest free one without rescanning.
	const counters = new Map<string, number>();
	let repaired = false;
	const freshId = (prefix: string): string => {
		let counter = counters.get(prefix) ?? 0;
		let id: string;
		do id = `${prefix}-${++counter}`;
		while (taken.has(id));
		counters.set(prefix, counter);
		taken.add(id);
		return id;
	};
	const fill =
		(prefix: string) =>
		(entry: Content): void => {
			if (usableId(entry['id'])) return;
			repaired = true;
			if (write) entry['id'] = freshId(prefix);
		};
	forEachTreeEntry(roots, fill('block'), fill('section'));
	if (!renewRepeated || (repaired && !write)) return repaired;

	const renew = (prefix: string, onRenew?: (from: string, to: string) => void) => {
		const seen = new Set<string>();
		return (entry: Content): void => {
			const id = entry['id'];
			if (usableId(id) && seen.has(id)) {
				repaired = true;
				if (write) {
					const renewed = freshId(prefix);
					entry['id'] = renewed;
					onRenew?.(id, renewed);
				}
			}
			if (usableId(entry['id'])) seen.add(entry['id']);
		};
	};
	forEachTreeEntry(roots, renew('block', onRenewBlock), renew('section'));
	return repaired;
}

/**
 * `roots` with every Block and accordion section, at any depth, holding a
 * non-empty string id: a missing or non-string one gets a fresh id, and with
 * `renewRepeated` so does every repeat of an id used earlier in the document.
 * Ids that are already usable are kept.
 *
 * Deterministic: the same input always gets the same fresh ids (`block-<n>`,
 * `section-<n>`, skipping every id in use), so repeated reads of one stored
 * document agree and the editor's echo guard recognises its own document.
 *
 * Nothing the caller owns is mutated. A tree that needs no repair comes back
 * as a new array holding the same entries; otherwise the entries are copies.
 * Entries that are not Block-shaped are left where they are.
 */
export function normalizeBlockTreeIds<T>(
	roots: readonly T[],
	options: NormalizeBlockTreeIdsOptions = {}
): T[] {
	const renewRepeated = options.renewRepeated ?? false;
	if (!repairTreeIds(roots, renewRepeated, false)) return [...roots];
	// Stored Blocks are plain JSON, so a copy under the JSON rules is a faithful
	// one (and, unlike structuredClone, accepts a reactive proxy).
	const copy = jsonClone([...roots]);
	repairTreeIds(copy, renewRepeated, true);
	return copy;
}

/** A Block id `normalizeBlockTreeIds` renews: the repeat of `from` now has `to`. */
export interface BlockIdRenewal {
	from: string;
	to: string;
}

/**
 * The Block ids `normalizeBlockTreeIds(roots, { renewRepeated: true })` renews,
 * in document order. The renewal is deterministic, so the server can tell from
 * the stored document which ids the editor gave the repeats of an id, and copy
 * each copy's translation overlay to its new id when the editor saves.
 * Accordion section ids are not translation keys and are not listed.
 */
export function repeatedBlockIdRenewals(roots: readonly unknown[]): BlockIdRenewal[] {
	const renewals: BlockIdRenewal[] = [];
	const copy = jsonClone([...roots]);
	repairTreeIds(copy, true, true, (from, to) => renewals.push({ from, to }));
	return renewals;
}
