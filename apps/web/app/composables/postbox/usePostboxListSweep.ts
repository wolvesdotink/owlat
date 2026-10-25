/**
 * The Postbox thread list's sweep: `usePostboxSweep` bound to the list's rows,
 * its selection and its archive verb. A checkbox sweep writes the selection in
 * one step; an Archive sweep runs ONE archive over the covered rows, so the
 * optimistic hide, the failure restore and the single "Undo" entry are the
 * same as for any other multi-row triage.
 */

import { computed, type Ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import { usePostboxSweep } from './usePostboxSweep';

interface SweepRow {
	_id: Id<'mailMessages'>;
	mailboxId?: string;
}

export function usePostboxListSweep(args: {
	/** The rows as rendered (optimistic hides already applied), in order. */
	rows: Ref<readonly SweepRow[]>;
	listEl: Ref<HTMLElement | null | undefined>;
	scopeKey: () => unknown;
	bulk: {
		isSelected: (id: Id<'mailMessages'>) => boolean;
		setRange: (ids: Id<'mailMessages'>[], on: boolean, anchorId: Id<'mailMessages'>) => void;
	};
	archiveMany: (ids: Id<'mailMessages'>[]) => Promise<boolean>;
}) {
	const byId = computed(() => new Map(args.rows.value.map((row) => [row._id as string, row])));

	return usePostboxSweep({
		orderedIds: () => args.rows.value.map((row) => row._id),
		listEl: () => args.listEl.value,
		isSelected: (id) => args.bulk.isSelected(id as Id<'mailMessages'>),
		// One archive call resolves its Archive folder from the first message, so
		// a range must not reach rows of another mailbox.
		canApply: (mark, originId, id) =>
			mark !== 'archive' ||
			(byId.value.get(id)?.mailboxId ?? null) === (byId.value.get(originId)?.mailboxId ?? null),
		scopeKey: args.scopeKey,
		onCommit: ({ mark, originId, ids }) => {
			const messageIds = ids as Id<'mailMessages'>[];
			if (mark === 'archive') void args.archiveMany(messageIds);
			else args.bulk.setRange(messageIds, mark === 'select', originId as Id<'mailMessages'>);
		},
	});
}
