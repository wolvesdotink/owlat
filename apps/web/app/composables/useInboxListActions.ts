import type { Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { InboxThreadRowThread } from '~/components/inbox/InboxThreadRow.vue';
import type { UndoGroup } from '~/composables/postbox/usePostboxTriageUndo';
import type { useInboxTriage } from '~/composables/useInboxTriage';
import type { InboxFilter } from '~/utils/inboxFilters';
import { runBounded } from '~/utils/runBounded';

export type InboxListThread = InboxThreadRowThread & { _id: Id<'conversationThreads'> };

/**
 * Tabs whose rows require an open/waiting, not-snoozed thread: resolving or
 * snoozing a row removes it from these, so those actions hide optimistically.
 */
export const INBOX_ACTIVE_WORK_FILTERS: ReadonlySet<InboxFilter> = new Set(['open', 'waiting']);

/**
 * How many rows of a bulk verb are in flight at once. Enough that twenty rows
 * do not crawl, few enough that a selection of a hundred does not open a
 * hundred writes against one connection.
 */
const BULK_CONCURRENCY = 4;

/**
 * The Team Inbox list's triage verbs (assign, resolve, snooze), for one row or
 * many. Every entry point (the row's hover controls, the keyboard, the bulk
 * bar, the row menu and the swipe) calls these, so a verb has one definition.
 *
 * Each row still goes through `useInboxTriage` on its own: hidden at once when
 * the verb takes it out of the current view, restored when its write fails,
 * and undoable by itself. Consecutive rows of one verb share one toast that
 * counts them ("Resolved 3 conversations · Undo all"), and an undo puts back
 * each row's own prior status or owner, captured when the verb was invoked.
 *
 * A bulk verb that partly fails says so once ("2 of 5 weren't resolved") and
 * leaves exactly the failed rows selected, so the person can retry them. The
 * first failure of a run keeps its specific error toast; the rest are folded
 * into that summary instead of stacking one toast per row.
 */
export function useInboxListActions(opts: {
	runTriage: ReturnType<typeof useInboxTriage<InboxListThread>>['run'];
	filter: Ref<InboxFilter>;
	assignee: Ref<string>;
	/** Org members, for naming an assignee in the undo toast. */
	members: Ref<{ userId: string; name?: string | null; email: string }[]>;
	/** Whether a row is part of the list's selection right now. */
	isSelected: (id: string) => boolean;
	/**
	 * Called after a verb on the selection settles, with the rows whose write
	 * failed. Whether the verb ran on the selection is decided when it is
	 * invoked: by the time the writes land, rows that left the view have also
	 * left the selection.
	 */
	onSelectionSettled: (targets: readonly InboxListThread[], failedIds: string[]) => void;
}) {
	const { t } = useI18n();
	const { user } = useAuth();
	const { showToast } = useToast();

	// Above zero while a run has already shown one failure: further failures
	// of that run are counted into its summary instead of toasting each.
	let quietRuns = 0;
	const quietAfterFirst = () => quietRuns > 0;

	const { run: assignThread } = useBackendOperation(api.inbox.mutations.assignThread, {
		label: () => t('dashboard.inbox.index.assignThreadOperation'),
		onError: quietAfterFirst,
	});
	const { run: updateThreadStatus } = useBackendOperation(api.inbox.mutations.updateThreadStatus, {
		label: () => t('dashboard.inbox.index.updateThreadStatusOperation'),
		onError: quietAfterFirst,
	});
	const { run: snoozeThread } = useBackendOperation(api.inbox.snooze.snoozeThread, {
		label: () => t('dashboard.inbox.index.snoozeThreadOperation'),
		onError: quietAfterFirst,
	});
	const { run: unsnoozeThread } = useBackendOperation(api.inbox.snooze.unsnoozeThread, {
		label: () => t('dashboard.inbox.index.unsnoozeThreadOperation'),
	});

	/**
	 * Run `perRow` over the targets, a few at a time, and report the rows whose
	 * write failed. `perRow` resolves `false` for a failure and `null` for a row
	 * the verb leaves alone (already in that state).
	 */
	async function runVerb(
		targets: readonly InboxListThread[],
		verb: 'resolved' | 'snoozed' | 'assigned',
		perRow: (thread: InboxListThread) => Promise<boolean | null>,
		fromSelection = onSelection(targets)
	): Promise<string[]> {
		const failed: string[] = [];
		let quieted = false;
		try {
			await runBounded(targets, BULK_CONCURRENCY, async (thread) => {
				const outcome = await perRow(thread);
				if (outcome !== false) return;
				failed.push(thread._id);
				if (!quieted) {
					quieted = true;
					quietRuns += 1;
				}
			});
		} finally {
			if (quieted) quietRuns -= 1;
		}
		if (failed.length > 0 && targets.length > 1) {
			showToast(
				t(
					`dashboard.inbox.index.bulk.failed.${verb}`,
					{ count: failed.length, total: targets.length },
					failed.length
				),
				'error'
			);
		}
		// Keep the list order, not the order the writes settled in.
		const order = targets.map((thread) => thread._id).filter((id) => failed.includes(id));
		if (fromSelection) opts.onSelectionSettled(targets, order);
		return order;
	}

	function onSelection(targets: readonly InboxListThread[]): boolean {
		return targets.some((thread) => opts.isSelected(thread._id));
	}

	/**
	 * Undo-toast copy for an assignment: the single action, and the shared toast a
	 * run of assignments to the same person collapses into.
	 */
	function assignUndo(assignedTo: string | undefined): { label: string; group: UndoGroup } {
		const many = (key: string, params: Record<string, string> = {}): UndoGroup => ({
			key: `inbox:assign:${assignedTo ?? ''}`,
			label: (count) => t(`dashboard.inbox.index.undo.${key}`, { ...params, count }, count),
		});
		if (assignedTo === undefined) {
			return { label: t('dashboard.inbox.index.undo.unassigned'), group: many('unassignedMany') };
		}
		if (assignedTo === user.value?.id) {
			return {
				label: t('dashboard.inbox.index.undo.assignedToYou'),
				group: many('assignedToYouMany'),
			};
		}
		const member = opts.members.value.find((m) => m.userId === assignedTo);
		const name = member?.name || member?.email;
		return name
			? {
					label: t('dashboard.inbox.index.undo.assignedTo', { name }),
					group: many('assignedToMany', { name }),
				}
			: { label: t('dashboard.inbox.index.undo.assigned'), group: many('assignedMany') };
	}

	/** Consecutive resolves (or snoozes) share one undo toast that counts them. */
	function statusUndoGroup(kind: 'resolved' | 'snoozed'): UndoGroup {
		return {
			key: `inbox:${kind}`,
			label: (count) => t(`dashboard.inbox.index.undo.${kind}Many`, { count }, count),
		};
	}

	/** Does assigning to `assignedTo` drop the row from the active assignment filter? */
	function assignLeavesView(assignedTo: string | undefined): boolean {
		if (opts.assignee.value === 'unassigned') return assignedTo !== undefined;
		if (opts.assignee.value === 'me') return assignedTo !== user.value?.id;
		return false;
	}

	/** Assign/unassign each target, with an undo that restores its own prior owner. */
	function assign(targets: readonly InboxListThread[], assignedTo: string | undefined) {
		const copy = assignUndo(assignedTo);
		const leavesView = assignLeavesView(assignedTo);
		return runVerb(targets, 'assigned', async (thread) => {
			const previous = thread.assignedTo ?? undefined;
			if (previous === assignedTo) return null;
			return opts.runTriage({
				id: thread._id,
				...copy,
				leavesView,
				mutate: () => assignThread({ threadId: thread._id, assignedTo }),
				inverse: () => assignThread({ threadId: thread._id, assignedTo: previous }),
			});
		});
	}

	/** `i`: claim the targets for the current user. */
	function assignToMe(targets: readonly InboxListThread[]) {
		const me = user.value?.id;
		if (!me) return Promise.resolve([] as string[]);
		return assign(targets, me);
	}

	/**
	 * `e` and the Resolve control. The list's done state is `resolved`: the UI
	 * merged the legacy `closed` status into it, and no tab lists `closed`, so a
	 * row closed that way would vanish from every view.
	 */
	function resolve(targets: readonly InboxListThread[]) {
		const leavesView = INBOX_ACTIVE_WORK_FILTERS.has(opts.filter.value);
		return runVerb(targets, 'resolved', async (thread) => {
			const previousStatus = thread.status;
			if (previousStatus === 'resolved') return null;
			return opts.runTriage({
				id: thread._id,
				label: t('dashboard.inbox.index.undo.resolved'),
				group: statusUndoGroup('resolved'),
				leavesView,
				mutate: () => updateThreadStatus({ threadId: thread._id, status: 'resolved' }),
				inverse: () => updateThreadStatus({ threadId: thread._id, status: previousStatus }),
			});
		});
	}

	// Snooze picker: reuses the Postbox snooze presets (PostboxSnoozeDialog).
	// The targets are captured when it opens, so a live update or a change of
	// selection while the dialog is up cannot change what gets snoozed.
	const showSnoozeDialog = ref(false);
	const snoozeTargets = shallowRef<readonly InboxListThread[]>([]);
	let snoozeFromSelection = false;
	function openSnooze(targets: readonly InboxListThread[]) {
		if (targets.length === 0) return;
		snoozeTargets.value = [...targets];
		snoozeFromSelection = onSelection(targets);
		showSnoozeDialog.value = true;
	}
	function onSnoozeConfirm(until: number) {
		showSnoozeDialog.value = false;
		const targets = snoozeTargets.value;
		snoozeTargets.value = [];
		const leavesView = INBOX_ACTIVE_WORK_FILTERS.has(opts.filter.value);
		return runVerb(
			targets,
			'snoozed',
			(thread) =>
				opts.runTriage({
					id: thread._id,
					label: t('dashboard.inbox.index.undo.snoozed'),
					group: statusUndoGroup('snoozed'),
					leavesView,
					mutate: () => snoozeThread({ threadId: thread._id, until }),
					inverse: () => unsnoozeThread({ threadId: thread._id }),
				}),
			snoozeFromSelection
		);
	}

	return {
		assign,
		assignToMe,
		resolve,
		showSnoozeDialog,
		snoozeCount: computed(() => snoozeTargets.value.length),
		openSnooze,
		onSnoozeConfirm,
	};
}
