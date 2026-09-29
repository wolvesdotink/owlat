import type { OptimisticLocalStore, OptimisticUpdate } from 'convex/browser';
import type { FunctionArgs } from 'convex/server';
import { api } from '@owlat/api';
import type { Doc } from '@owlat/api/dataModel';
import { updateQueries } from '~/lib/optimisticStore';

/**
 * Native optimistic updates for the label rail's own edits: rename, colour,
 * pin, re-parent and reorder. They patch the cached label lists (the rail's
 * `labels.list` and the labels the open conversation carries), so a drag or a
 * rename settles in place instead of snapping back until the server answers.
 */

type Label = Doc<'mailLabels'>;

/** Rewrite every cached label list: the rail's and the open conversation's. */
function patchLabels(store: OptimisticLocalStore, patch: (labels: Label[]) => Label[]): void {
	updateQueries(store, api.mail.labels.list, (labels) => patch(labels));
	updateQueries(store, api.mail.mailbox.messages.listThreadMessages, (value) => {
		if (!value) return value;
		const labels = patch(value.labels);
		return labels === value.labels ? value : { ...value, labels };
	});
}

function mapLabels(labels: Label[], rewrite: (label: Label) => Label): Label[] {
	let changed = false;
	const next = labels.map((label) => {
		const out = rewrite(label);
		if (out !== label) changed = true;
		return out;
	});
	return changed ? next : labels;
}

/**
 * `labels.update`: the same field rules as the server (a trimmed name, an empty
 * colour clears it, a `null` parent detaches to a root). The server's checks
 * (unique sibling names, nesting depth, cycles) still decide; a refused edit
 * shows its toast and Convex drops this patch.
 */
export const optimisticUpdateLabel: OptimisticUpdate<
	FunctionArgs<typeof api.mail.labels.update>
> = (store, args) => {
	patchLabels(store, (labels) =>
		mapLabels(labels, (label) => {
			if (label._id !== args.labelId) return label;
			const next: Label = { ...label };
			if (args.name !== undefined && args.name.trim()) next.name = args.name.trim();
			if (args.order !== undefined) next.order = args.order;
			if (args.isPinned !== undefined) next.isPinned = args.isPinned;
			if (args.color !== undefined) {
				if (args.color) next.color = args.color;
				else delete next.color;
			}
			if (args.parentId !== undefined) {
				if (args.parentId === null) delete next.parentId;
				else next.parentId = args.parentId;
			}
			return next;
		})
	);
};

/** `labels.reorder`: the ids in their new order get `order` 0..n-1. */
export const optimisticReorderLabels: OptimisticUpdate<
	FunctionArgs<typeof api.mail.labels.reorder>
> = (store, args) => {
	const order = new Map<string, number>(args.labelIds.map((id, index) => [id, index]));
	patchLabels(store, (labels) =>
		mapLabels(labels, (label) => {
			const index = order.get(label._id);
			if (index === undefined || label.mailboxId !== args.mailboxId || label.order === index) {
				return label;
			}
			return { ...label, order: index };
		})
	);
};
