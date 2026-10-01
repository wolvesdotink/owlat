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
	/** Give fresh ids to the non-Block entries the content owns (accordion sections). */
	renewEntryIds?(content: Content, newId: () => string): void;
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
		renewEntryIds: (content, newId) => {
			for (const section of sectionsOf(content)) {
				if (isRecord(section)) section['id'] = newId();
			}
		},
	},
};

const isNode = (value: unknown): value is BlockTreeNode =>
	isRecord(value) && typeof value['id'] === 'string' && typeof value['type'] === 'string';

const slotOf = (node: BlockTreeNode): { slot: ChildSlot; content: Content } | null => {
	const slot = CHILD_SLOTS[node.type];
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
 * Give `node` and every descendant a fresh id, in place. Call it on a deep
 * copy: a duplicated or re-inserted Block must not share any id with the
 * original, or edits and translation overlays keyed by a child id would reach
 * both copies.
 */
export function renewBlockTreeIds(node: BlockTreeNode, newId: () => string): void {
	node.id = newId();
	const found = slotOf(node);
	if (!found) return;
	found.slot.renewEntryIds?.(found.content, newId);
	for (const list of childBlockLists(node)) {
		for (const child of list) renewBlockTreeIds(child, newId);
	}
}
