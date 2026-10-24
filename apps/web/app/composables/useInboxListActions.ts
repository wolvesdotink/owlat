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
 *
 * The pickers (assign, snooze) capture their targets, and whether those came
 * from the selection, when they open: a live update or a change of selection
 * while a picker is up cannot change what its confirmation acts on.
 */
export function useInboxListActions(opts: {
	runTriage: ReturnType<typeof useInboxTriage<InboxListThread>>['run'];
	filter: Ref<InboxFilter>;
	assignee: Ref<string>;
	/** Org members, for naming an assignee in the undo toast. */
	members: Ref<{ userId: string; name?: string | null; email: string }[]>;
	/**
	 * Called when a verb is invoked on `targets`. When the verb acts on the
	 * list's selection, returns how to settle it once the writes land, given
	 * the rows whose write failed; `null` otherwise. Deciding at invocation
	 * matters: by the time the writes land, rows that left the view have also
	 * left the selection, and the view itself may have changed.
	 */
	captureSelection: (
		targets: readonly InboxListThread[]
	) => ((failedIds: readonly string[]) => boolean) | null;
}) {
	const { t } = useI18n();
	const { user } = useAuth();
	const { showToast } = useToast();

	const { run: assignThread } = useBackendOperation(api.inbox.mutations.assignThread, {
		label: () => t('dashboard.inbox.index.assignThreadOperation'),
	});
	const { run: updateThreadStatus } = useBackendOperation(api.inbox.mutations.updateThreadStatus, {
		label: () => t('dashboard.inbox.index.updateThreadStatusOperation'),
	});
	const { run: snoozeThread } = useBackendOperation(api.inbox.snooze.snoozeThread, {
		label: () => t('dashboard.inbox.index.snoozeThreadOperation'),
	});
	const { run: unsnoozeThread } = useBackendOperation(api.inbox.snooze.unsnoozeThread, {
		label: () => t('dashboard.inbox.index.unsnoozeThreadOperation'),
	});

	type SettleSelection = ReturnType<typeof opts.captureSelection>;
	/** A forward write's failure claim, scoped to the run it belongs to. */
	type ClaimError = () => boolean;

	/**
	 * Run `perRow` over the targets, a few at a time, and report the rows whose
	 * write failed. `perRow` resolves `false` for a failure and `null` for a row
	 * the verb leaves alone (already in that state), and hands `claimError` to
	 * its forward write as that run's `onError`.
	 */
	async function runVerb(
		targets: readonly InboxListThread[],
		verb: 'resolved' | 'snoozed' | 'assigned',
		perRow: (thread: InboxListThread, claimError: ClaimError) => Promise<boolean | null>,
		settleSelection: SettleSelection = opts.captureSelection(targets)
	): Promise<string[]> {
		// The run's first failure keeps its own error toast; every later one is
		// claimed (silenced) and counted into the summary. Decided inside the
		// failure handler itself, so writes that fail together still show one.
		let errorShown = false;
		const claimError: ClaimError = () => {
			if (errorShown) return true;
			errorShown = true;
			return false;
		};
		const failed = new Set<string>();
		await runBounded(targets, BULK_CONCURRENCY, async (thread) => {
			if ((await perRow(thread, claimError)) === false) failed.add(thread._id);
		});
		// Keep the list order, not the order the writes settled in.
		const order = targets.map((thread) => thread._id).filter((id) => failed.has(id));
		const keptSelected = settleSelection?.(order) ?? false;
		if (order.length > 0 && targets.length > 1) {
			// "They stay selected" only when they do: not after the view changed
			// under the run, nor when a failed row has left the list since.
			const key = keptSelected ? 'failed' : 'failedUnselected';
			showToast(
				t(
					`dashboard.inbox.index.bulk.${key}.${verb}`,
					{ count: order.length, total: targets.length },
					order.length
				),
				'error'
			);
		}
		return order;
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
	function assign(
		targets: readonly InboxListThread[],
		assignedTo: string | undefined,
		settleSelection: SettleSelection = opts.captureSelection(targets)
	) {
		const copy = assignUndo(assignedTo);
		const leavesView = assignLeavesView(assignedTo);
		return runVerb(
			targets,
			'assigned',
			async (thread, onError) => {
				const previous = thread.assignedTo ?? undefined;
				if (previous === assignedTo) return null;
				return opts.runTriage({
					id: thread._id,
					...copy,
					leavesView,
					mutate: () => assignThread({ threadId: thread._id, assignedTo }, { onError }),
					inverse: () => assignThread({ threadId: thread._id, assignedTo: previous }),
				});
			},
			settleSelection
		);
	}

	/** `i`: claim the targets for the current user. */
	function assignToMe(targets: readonly InboxListThread[]) {
		const me = user.value?.id;
		if (!me) return Promise.resolve([] as string[]);
		return assign(targets, me);
	}

	// Assignee picker: whichever picker opens (a row's own, or the bulk bar's)
	// confirms against the targets captured here when it opened.
	let assignTargets: readonly InboxListThread[] = [];
	let assignSettle: SettleSelection = null;
	function openAssign(targets: readonly InboxListThread[]) {
		assignTargets = [...targets];
		assignSettle = opts.captureSelection(targets);
	}
	function onAssignConfirm(assignedTo: string | undefined) {
		const targets = assignTargets;
		const settle = assignSettle;
		assignTargets = [];
		assignSettle = null;
		if (targets.length === 0) return Promise.resolve([] as string[]);
		return assign(targets, assignedTo, settle);
	}

	/**
	 * `e` and the Resolve control. The list's done state is `resolved`: the UI
	 * merged the legacy `closed` status into it, and no tab lists `closed`, so a
	 * row closed that way would vanish from every view.
	 */
	function resolve(targets: readonly InboxListThread[]) {
		const leavesView = INBOX_ACTIVE_WORK_FILTERS.has(opts.filter.value);
		return runVerb(targets, 'resolved', async (thread, onError) => {
			const previousStatus = thread.status;
			if (previousStatus === 'resolved') return null;
			return opts.runTriage({
				id: thread._id,
				label: t('dashboard.inbox.index.undo.resolved'),
				group: statusUndoGroup('resolved'),
				leavesView,
				mutate: () => updateThreadStatus({ threadId: thread._id, status: 'resolved' }, { onError }),
				inverse: () => updateThreadStatus({ threadId: thread._id, status: previousStatus }),
			});
		});
	}

	/**
	 * Undo of a snooze: a row that was already snoozed goes back to its own
	 * earlier deadline (rescheduling from the Snoozed tab must not wake it), a
	 * row that was not is woken. A deadline that has passed by the time of the
	 * undo has nothing to go back to, and the backend refuses a past one.
	 */
	function undoSnooze(threadId: InboxListThread['_id'], previousUntil: number | null) {
		if (previousUntil !== null && previousUntil > Date.now()) {
			return snoozeThread({ threadId, until: previousUntil });
		}
		return unsnoozeThread({ threadId });
	}

	// Snooze picker: reuses the Postbox snooze presets (PostboxSnoozeDialog),
	// with its targets captured when it opens.
	const showSnoozeDialog = ref(false);
	const snoozeTargets = shallowRef<readonly InboxListThread[]>([]);
	let snoozeSettle: SettleSelection = null;
	function openSnooze(targets: readonly InboxListThread[]) {
		if (targets.length === 0) return;
		snoozeTargets.value = [...targets];
		snoozeSettle = opts.captureSelection(targets);
		showSnoozeDialog.value = true;
	}
	function onSnoozeConfirm(until: number) {
		showSnoozeDialog.value = false;
		const targets = snoozeTargets.value;
		const settle = snoozeSettle;
		snoozeTargets.value = [];
		snoozeSettle = null;
		const leavesView = INBOX_ACTIVE_WORK_FILTERS.has(opts.filter.value);
		return runVerb(
			targets,
			'snoozed',
			(thread, onError) => {
				// The deadline the undo goes back to, from before this snooze.
				const previousUntil = thread.snoozedUntil ?? null;
				return opts.runTriage({
					id: thread._id,
					label: t('dashboard.inbox.index.undo.snoozed'),
					group: statusUndoGroup('snoozed'),
					leavesView,
					mutate: () => snoozeThread({ threadId: thread._id, until }, { onError }),
					inverse: () => undoSnooze(thread._id, previousUntil),
				});
			},
			settle
		);
	}

	return {
		assignToMe,
		openAssign,
		onAssignConfirm,
		resolve,
		showSnoozeDialog,
		snoozeCount: computed(() => snoozeTargets.value.length),
		openSnooze,
		onSnoozeConfirm,
	};
}
