/**
 * Team Updates: press a row's Dismiss button and drag across the list to
 * dismiss every update the pointer passes, on release.
 *
 * Dismissing is the page's own verb (`dismissUpdate`: `informational →
 * archived`), admin-only and terminal, so there is no Undo and the sweep obeys
 * the same guards as the button: admins only, never in the Spam view, never
 * while another action on the page is running. There is no batch mutation, so
 * a sweep runs one dismissal per row; the rows hide at once, each failed one
 * comes back, and one toast counts what landed instead of one per row. The
 * first failure surfaces through the usual error treatment; the rest of the
 * same sweep are folded into it rather than stacking a toast each.
 */

import { computed, ref, type Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { usePostboxSweep } from './postbox/usePostboxSweep';

interface DismissableRow {
	_id: Id<'inboundMessages'>;
	item: { message: { processingStatus?: string } };
}

/** Marks a sweep's batch in `actionInProgress`, which otherwise holds one row id. */
const SWEEP_IN_PROGRESS = 'sweep';

export function useUpdatesDismissSweep(args: {
	/** The rows in the order they render (grouped by importance). */
	rows: Ref<DismissableRow[]>;
	/** The tab; switching tabs mid-sweep cancels it. */
	scopeKey: () => unknown;
	/** Whether a dismissal may run at all right now (admin, not the Spam view). */
	canDismiss: () => boolean;
	/** The page's one-action-at-a-time lock, shared with the row buttons. */
	actionInProgress: Ref<string | null>;
	/** The page's optimistic hide, shared with the row buttons. */
	rowHide: { hide: (id: string) => void; unhide: (id: string) => void };
}) {
	const { t } = useI18n();
	const { showToast } = useToast();
	let hasSurfacedFailure = false;
	const dismissOp = useBackendOperation(api.inbox.updates.dismissUpdate, {
		label: () => t('dashboard.inbox.updates.dismissOperation'),
		// One announcement for the batch (the toast below), not one per row.
		announce: false,
		onError: () => {
			if (!hasSurfacedFailure) {
				hasSurfacedFailure = true;
				return false;
			}
			return true;
		},
	});

	const listEl = ref<HTMLElement | null>(null);
	const isIdle = () => args.canDismiss() && args.actionInProgress.value === null;
	const statusById = computed(
		() => new Map(args.rows.value.map((row) => [row._id, row.item.message.processingStatus]))
	);

	async function dismissRows(ids: readonly Id<'inboundMessages'>[]) {
		if (ids.length === 0 || !isIdle()) return;
		args.actionInProgress.value = SWEEP_IN_PROGRESS;
		hasSurfacedFailure = false;
		for (const id of ids) args.rowHide.hide(id);
		try {
			const outcomes = await Promise.all(
				ids.map(async (id) => {
					const outcome = await dismissOp.run({ inboundMessageId: id });
					if (!outcome.ok) args.rowHide.unhide(id);
					return outcome.ok;
				})
			);
			const dismissed = outcomes.filter(Boolean).length;
			if (dismissed > 0) {
				showToast(t('dashboard.inbox.updates.dismissedManyToast', { count: dismissed }, dismissed));
			}
		} finally {
			args.actionInProgress.value = null;
		}
	}

	const sweep = usePostboxSweep({
		orderedIds: () => args.rows.value.map((row) => row._id),
		listEl: () => listEl.value,
		isSelected: () => false,
		// Only rows still waiting as updates; the server re-checks for races.
		canApply: (mark, _originId, id) =>
			mark === 'dismiss' && statusById.value.get(id as Id<'inboundMessages'>) === 'informational',
		scopeKey: args.scopeKey,
		onCommit: ({ ids }) => void dismissRows(ids as Id<'inboundMessages'>[]),
	});

	return {
		/** The list element; bind it with `:ref`. */
		listEl,
		markOf: sweep.markOf,
		status: sweep.status,
		active: sweep.active,
		/** A press on a row's Dismiss button: a sweep may start only when a dismissal could. */
		start(id: Id<'inboundMessages'>, event: PointerEvent) {
			if (isIdle()) sweep.start('dismiss', id, event);
		},
	};
}
