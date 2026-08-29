/**
 * Build the folder rail's label tree from the flat `mailLabels` rows.
 *
 * Pure and Convex-free so the ordering rules, the rollup counts and the
 * orphan/cycle handling test without mounting the rail. The backend guards
 * against writing a cycle, but the tree build never assumes that: a row set
 * arriving mid-reparent, or one written before the guard existed, must still
 * render every label somewhere rather than silently dropping a branch.
 */

export interface PostboxLabelNodeInput {
	_id: string;
	name: string;
	color?: string;
	parentId?: string;
	order?: number;
	isPinned?: boolean;
}

export interface PostboxLabelNode<T extends PostboxLabelNodeInput = PostboxLabelNodeInput> {
	label: T;
	depth: number;
	children: PostboxLabelNode<T>[];
	/** Unread on this label alone. */
	unreadCount: number;
	/** Unread on this label plus everything under it — what a COLLAPSED row shows. */
	totalUnreadCount: number;
}

/**
 * Sibling order: pinned first, then the manual `order`, then name.
 *
 * `order` is optional, and a mailbox whose labels all predate nesting has it
 * absent everywhere — so the name tiebreak is what keeps that mailbox reading
 * alphabetically, exactly as the flat wall did.
 */
function compareSiblings(a: PostboxLabelNodeInput, b: PostboxLabelNodeInput): number {
	if (Boolean(a.isPinned) !== Boolean(b.isPinned)) return a.isPinned ? -1 : 1;
	const orderDelta = (a.order ?? 0) - (b.order ?? 0);
	if (orderDelta !== 0) return orderDelta;
	return a.name.localeCompare(b.name);
}

/**
 * Assemble the forest.
 *
 * A label whose `parentId` names a row that is not in the set (deleted, or
 * simply not loaded yet) is treated as a ROOT rather than dropped — an
 * invisible label is unusable and gives the user nothing to fix. Same for a
 * label caught inside a parent cycle: the ring's entry point is promoted to a
 * root so the whole ring still renders.
 */
export function buildLabelTree<T extends PostboxLabelNodeInput>(
	labels: readonly T[],
	unreadCounts: Readonly<Record<string, number>> = {}
): PostboxLabelNode<T>[] {
	const byId = new Map(labels.map((label) => [label._id, label]));

	/** Does walking up from this label reach a root within the set? */
	const reachesRoot = (start: T): boolean => {
		const seen = new Set<string>([start._id]);
		let current = start.parentId;
		while (current) {
			if (seen.has(current)) return false; // cycle
			const parent = byId.get(current);
			if (!parent) return true; // dangling parent: treat as a root below
			seen.add(current);
			current = parent.parentId;
		}
		return true;
	};

	const childrenOf = new Map<string, T[]>();
	const roots: T[] = [];
	for (const label of labels) {
		const parent = label.parentId ? byId.get(label.parentId) : undefined;
		if (!parent || !reachesRoot(label)) {
			roots.push(label);
			continue;
		}
		const bucket = childrenOf.get(parent._id);
		if (bucket) bucket.push(label);
		else childrenOf.set(parent._id, [label]);
	}

	const build = (label: T, depth: number): PostboxLabelNode<T> => {
		const children = [...(childrenOf.get(label._id) ?? [])]
			.sort(compareSiblings)
			.map((child) => build(child, depth + 1));
		const unreadCount = unreadCounts[label._id] ?? 0;
		return {
			label,
			depth,
			children,
			unreadCount,
			totalUnreadCount:
				unreadCount + children.reduce((sum, child) => sum + child.totalUnreadCount, 0),
		};
	};

	return roots.sort(compareSiblings).map((label) => build(label, 0));
}

/**
 * Flatten the forest to the rows the rail actually renders, honouring which
 * nodes are collapsed.
 *
 * A collapsed node keeps its own row (showing the rolled-up count) and hides
 * its descendants — including their collapse state, so re-expanding a branch
 * restores exactly what was under it.
 */
export function flattenLabelTree<T extends PostboxLabelNodeInput>(
	nodes: readonly PostboxLabelNode<T>[],
	collapsedIds: ReadonlySet<string>
): PostboxLabelNode<T>[] {
	const out: PostboxLabelNode<T>[] = [];
	const walk = (list: readonly PostboxLabelNode<T>[]) => {
		for (const node of list) {
			out.push(node);
			if (!collapsedIds.has(node.label._id)) walk(node.children);
		}
	};
	walk(nodes);
	return out;
}

/**
 * The ids on the path from a label up to its root, nearest ancestor first.
 *
 * Used to auto-expand the branch containing the active label: navigating to a
 * label that sits inside a collapsed branch must not leave the rail showing no
 * selection at all.
 */
export function labelAncestorIds<T extends PostboxLabelNodeInput>(
	labels: readonly T[],
	labelId: string
): string[] {
	const byId = new Map(labels.map((label) => [label._id, label]));
	const path: string[] = [];
	const seen = new Set<string>([labelId]);
	let current = byId.get(labelId)?.parentId;
	while (current && !seen.has(current)) {
		path.push(current);
		seen.add(current);
		current = byId.get(current)?.parentId;
	}
	return path;
}

/**
 * The full `Work/Clients/Acme` path of a label, for a tooltip or a picker where
 * the bare leaf name ("Acme") would not say which branch it belongs to.
 */
export function labelPath<T extends PostboxLabelNodeInput>(
	labels: readonly T[],
	labelId: string,
	separator = ' / '
): string {
	const byId = new Map(labels.map((label) => [label._id, label]));
	const leaf = byId.get(labelId);
	if (!leaf) return '';
	return [
		...labelAncestorIds(labels, labelId)
			.map((id) => byId.get(id)?.name ?? '')
			.reverse(),
		leaf.name,
	]
		.filter(Boolean)
		.join(separator);
}
