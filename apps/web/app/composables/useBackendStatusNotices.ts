import { api } from '@owlat/api';
import { reportRolloutActivity } from '~/lib/backendConnection';
import { onSlowEpisodeEnd, type SlowOperation } from '~/lib/pendingOperations';
import { useBackendStatus } from './useBackendStatus';

/** One line of the Details dialog: every waiting run of one operation. */
export interface SlowOperationGroup {
	label: string;
	count: number;
	/** The oldest run's start. */
	since: number;
}

/** Group waiting runs by label, oldest group first (a bulk action is one line, not fifty). */
export function groupSlowOperations(ops: readonly SlowOperation[]): SlowOperationGroup[] {
	const groups = new Map<string, SlowOperationGroup>();
	for (const op of ops) {
		const group = groups.get(op.label);
		if (group) {
			group.count += 1;
			group.since = Math.min(group.since, op.startedAt);
		} else {
			groups.set(op.label, { label: op.label, count: 1, since: op.startedAt });
		}
	}
	return [...groups.values()].sort((a, b) => a.since - b.since);
}

/**
 * The app-wide notices behind the shell's backend status, mounted once by
 * `BackendStatusHost`:
 *
 * - one sticky "Saving is taking longer than usual · Details" warning while any
 *   write has waited past the slow threshold, however many there are;
 * - "All changes saved" once that episode ends with every write landed (a
 *   reconnect alone proves nothing, and a failure already has its own toast);
 * - one spoken announcement per connection change, since the two visible
 *   indicators are deliberately not live regions;
 * - the rollout evidence feed: the open update run's start, read while
 *   connected, so a drop during an update can say so.
 *
 * Closing the warning silences it until the episode ends. Opening Details takes
 * its place; closing Details brings it back while writes are still waiting.
 */
export function useBackendStatusNotices() {
	const { t } = useI18n();
	const { showToast, removeToast } = useToast();
	const { announce } = useAnnounce();
	const { phase, hint, slowOperations } = useBackendStatus();

	const detailsOpen = ref(false);
	const groups = computed(() => groupSlowOperations(slowOperations.value));

	let warningId: string | null = null;
	let silenced = false;

	function showWarning(): void {
		if (warningId || silenced || detailsOpen.value || slowOperations.value.length === 0) return;
		const id = showToast(t('shared.backendStatus.slowSave'), 'warning', {
			durationMs: 0,
			action: {
				label: t('shared.backendStatus.details'),
				onAction: () => {
					detailsOpen.value = true;
				},
			},
			onDismiss: () => {
				if (warningId !== id) return;
				warningId = null;
				// Closed by the person, not replaced by Details: stay quiet until
				// this episode is over.
				if (!detailsOpen.value) silenced = true;
			},
		});
		warningId = id;
	}

	function hideWarning(): void {
		const id = warningId;
		if (!id) return;
		warningId = null;
		removeToast(id);
	}

	watch(
		() => slowOperations.value.length,
		(count) => (count > 0 ? showWarning() : hideWarning()),
		{ immediate: true }
	);
	watch(detailsOpen, (open) => {
		if (!open) showWarning();
	});

	const stopEpisodes = onSlowEpisodeEnd((outcome) => {
		silenced = false;
		hideWarning();
		if (outcome === 'saved') showToast(t('shared.backendStatus.allSaved'), 'success');
	});

	watch(phase, (next, previous) => {
		if (next) {
			announce(hint.value);
		} else if (previous === 'reconnecting' || previous === 'updating') {
			announce(t('shared.backendStatus.reconnected'));
		}
	});

	// `undefined` is "no answer yet" (or the subscription was reset for a new
	// identity): keep the last evidence rather than forget it mid-drop.
	const { data: rollout } = useConvexQuery(api.systemUpdates.getRolloutActivity, {});
	watch(
		rollout,
		(value) => {
			if (value !== undefined) reportRolloutActivity(value?.startedAt ?? null);
		},
		{ immediate: true }
	);

	onScopeDispose(() => {
		stopEpisodes();
		hideWarning();
	});

	return { detailsOpen, groups, phase, hint };
}
