/**
 * The label HIERARCHY — depth, path resolution and the reparent cycle guard.
 *
 * Split out of `mail/labels.ts` because these are the parts with no Convex
 * function surface of their own: they are the arithmetic the create/update
 * mutations and the bulk importers (`archiveImport`, `filtersImport`) all
 * share, and keeping them beside the mutations pushed that file past the
 * ~500 LOC split point in CONVENTIONS.md.
 *
 * Every helper here assumes the CALLER has already gated access to the mailbox.
 * None of them re-check permissions, because none of them can: they take ids,
 * not sessions.
 */

import type { MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';

/**
 * How deep a label may nest. Folders in every mail client top out around here,
 * and a bound is what keeps the reparent cycle guard, the tree build and the
 * rail's indentation all finite.
 */
export const LABEL_MAX_DEPTH = 5;

/** Path separator for nested creation — `Work/Clients/Acme`, like folders. */
export const LABEL_PATH_SEPARATOR = '/';

/** Depth of a label, counted by walking up to a root. */
export async function labelDepth(ctx: MutationCtx, labelId: Id<'mailLabels'>): Promise<number> {
	let depth = 0;
	let current = await ctx.db.get(labelId);
	while (current?.parentId && depth <= LABEL_MAX_DEPTH) {
		depth += 1;
		current = await ctx.db.get(current.parentId);
	}
	return depth;
}

/**
 * Find or create one segment under a parent. Sibling names are unique within a
 * parent (not mailbox-wide), so `Work/Archive` and `Personal/Archive` can both
 * exist — which is the whole point of nesting.
 */
export async function findOrCreateSegment(
	ctx: MutationCtx,
	mailboxId: Id<'mailboxes'>,
	name: string,
	parentId: Id<'mailLabels'> | undefined,
	color: string | undefined
): Promise<{ id: Id<'mailLabels'>; created: boolean }> {
	const siblings = await ctx.db
		.query('mailLabels')
		.withIndex('by_mailbox_and_parent', (q) =>
			q.eq('mailboxId', mailboxId).eq('parentId', parentId)
		)
		.collect(); // bounded: one parent's children
	const existing = siblings.find((row) => row.name === name);
	if (existing) return { id: existing._id, created: false };

	// Append to the end of the sibling run; ties break on name, so a mailbox
	// whose labels all sit at the default order still reads alphabetically.
	const order = siblings.reduce((max, row) => Math.max(max, row.order ?? 0), -1) + 1;
	const id = await ctx.db.insert('mailLabels', {
		mailboxId,
		name,
		color,
		parentId,
		order,
		createdAt: Date.now(),
	});
	return { id, created: true };
}

/**
 * Resolve a label PATH to its leaf, creating whatever is missing on the way.
 *
 * The idempotent half of {@link create}, without the caller-facing conflict
 * error: a bulk writer (the archive import mapping Gmail's `Work/Invoices`
 * labels) wants "give me this label" and needs to know how many rows it had to
 * make, not a throw when one of them already existed. Returns `null` for a name
 * with no usable segment or one that would nest past {@link LABEL_MAX_DEPTH},
 * so a strange label in an archive skips its label rather than failing the
 * message.
 *
 * The caller MUST have already gated access to `mailboxId`.
 */
export async function resolveLabelPath(
	ctx: MutationCtx,
	mailboxId: Id<'mailboxes'>,
	name: string
): Promise<{ labelId: Id<'mailLabels'>; created: number } | null> {
	const segments = name
		.split(LABEL_PATH_SEPARATOR)
		.map((part) => part.trim())
		.filter(Boolean);
	if (segments.length === 0 || segments.length - 1 > LABEL_MAX_DEPTH) return null;

	let parentId: Id<'mailLabels'> | undefined;
	let leafId: Id<'mailLabels'> | undefined;
	let created = 0;
	for (const segment of segments) {
		const result = await findOrCreateSegment(ctx, mailboxId, segment, parentId, undefined);
		if (result.created) created++;
		parentId = result.id;
		leafId = result.id;
	}
	return leafId ? { labelId: leafId, created } : null;
}

/**
 * Would reparenting `labelId` under `parentId` close a loop?
 *
 * A cycle detaches its whole ring from every root, so the tree build would
 * simply stop rendering those labels and the user would watch a branch
 * disappear with no error. Walking up from the proposed parent is the cheap
 * check: if we meet the label being moved, the edge would close the ring.
 */
export async function wouldCycle(
	ctx: MutationCtx,
	labelId: Id<'mailLabels'>,
	parentId: Id<'mailLabels'>
): Promise<boolean> {
	let current: Id<'mailLabels'> | undefined = parentId;
	for (let hops = 0; current && hops <= LABEL_MAX_DEPTH + 1; hops++) {
		if (current === labelId) return true;
		const row: Doc<'mailLabels'> | null = await ctx.db.get(current);
		current = row?.parentId;
	}
	return false;
}
