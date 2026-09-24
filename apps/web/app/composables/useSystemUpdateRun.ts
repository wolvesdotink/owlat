import { api } from '@owlat/api';
import { apiFetch } from '~/lib/csrfFetch';
import {
	isStartedRollout,
	isUpdaterRefusal,
	updateFailureMessage,
	updateRequestWasAnswered,
} from '~/lib/systemUpdate';

/**
 * The in-app update run, from "Update now" to a verdict.
 *
 * Lifted out of `pages/dashboard/admin/system/index.vue`, which also renders
 * container health, port checks, LLM spend and the update history and had grown
 * past the file-size cap. The update run is the one thing on that page with real
 * control flow — it survives its own transport dying — so it is the part that
 * earns a home of its own.
 */

/** One entry of the sidecar's step log, as the progress card reads it. */
interface UpdateStep {
	/** The sidecar's own verdict: did this step's docker command exit 0? */
	ok?: boolean;
	step: string;
	stdout?: string;
	stderr?: string;
}

/**
 * `started`: the release is applied and running, but not every service passed
 * the updater's readiness check in time. A warning, not a failure: running the
 * update again would change nothing.
 */
type UpdateState = 'idle' | 'confirming' | 'running' | 'success' | 'started' | 'failed';

/**
 * The route waits for the updater, and the updater waits for readiness after
 * the recreate, following each service's declared healthcheck cadence.
 */
const UPDATE_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * 128 random bits as hex. Not `crypto.randomUUID`, which only exists in a
 * secure context, and an instance may be reached over plain HTTP before its
 * TLS is set up.
 */
function newAttemptId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function useSystemUpdateRun(latestVersion: () => string | undefined) {
	const { t } = useI18n();
	const convex = useConvex();

	const updateState = ref<UpdateState>('idle');
	const updateSteps = ref<UpdateStep[] | null>(null);
	const updateError = ref<string>('');
	const updateWarning = ref<string>('');
	const pendingTargetVersion = ref<string>('');
	// This attempt's id: the updater echoes it on /health with its verdict, so
	// the progress card never reads an earlier attempt's verdict as this one's.
	const updateAttempt = ref<string>('');

	/**
	 * Close the `updateRun` row the update left open.
	 *
	 * The route that opened it is normally gone by the time the sidecar answers —
	 * its container is what the update recreated — so the browser is the only
	 * party left that can say how the run ended. Best-effort: an update that
	 * worked must not be reported as broken because its audit row could not be
	 * written, and a run the route DID manage to close is no longer `running`, so
	 * this finds nothing and does nothing.
	 */
	async function closeOpenRun(status: 'success' | 'failed', error?: string) {
		if (!convex) return;
		try {
			const open = await convex.query(api.systemUpdates.getUnfinishedUpdate, {});
			if (!open) return;
			await convex.mutation(api.systemUpdates.recordUpdateFinish, {
				runId: open.runId,
				status,
				...(error ? { error } : {}),
			});
		} catch (err) {
			console.error('[system/update] could not close the update run', err);
		}
	}

	// A run is in flight until the progress card or the route reaches a verdict.
	const updateInProgress = computed(() => updateState.value === 'running');

	function startUpdate() {
		// Starting over mid-run would swap the progress card for a confirm, and
		// the updater answers a second run with 409 anyway.
		if (updateInProgress.value) return;
		const target = latestVersion();
		if (!target) return;
		pendingTargetVersion.value = target;
		updateState.value = 'confirming';
	}

	function cancelConfirm() {
		updateState.value = 'idle';
		pendingTargetVersion.value = '';
	}

	async function confirmUpdate() {
		updateState.value = 'running';
		updateError.value = '';
		updateWarning.value = '';
		updateSteps.value = null;
		updateAttempt.value = newAttemptId();

		try {
			const resp = await apiFetch<{ steps?: UpdateStep[]; rollout?: string; warning?: string }>(
				'/api/system/update',
				{
					method: 'POST',
					body: { targetVersion: pendingTargetVersion.value, attempt: updateAttempt.value },
					retry: 0,
					timeout: UPDATE_REQUEST_TIMEOUT_MS,
				}
			);
			updateSteps.value = resp.steps ?? null;
			// The route closed the run already; nothing is left for the card to wait for.
			if (isStartedRollout(resp)) {
				updateState.value = 'started';
				updateWarning.value = resp.warning ?? '';
			}
			// Otherwise don't set success yet — UpdateProgress confirms it from updater health.
		} catch (err) {
			// A throw the server did not put there is the web container being
			// recreated by the update's last step — the progress card keeps the
			// verdict and resolves it from updater health.
			if (!updateRequestWasAnswered(err)) return;
			const statusCode = (err as { statusCode?: unknown }).statusCode;
			updateState.value = 'failed';
			updateError.value =
				statusCode === 409
					? t('dashboard.admin.system.index.updateBusy')
					: updateFailureMessage(err, t('dashboard.admin.system.index.unknownError'));
			// A refused update never ran, and the route took its row back. The
			// open run, if any, is the rollout that refused it, not this one.
			if (!isUpdaterRefusal(statusCode)) void closeOpenRun('failed', updateError.value);
		}
	}

	async function onUpdateComplete() {
		updateState.value = 'success';
		// Awaited, not fired alongside the reload: the row has to be closed before
		// the page goes away, or the history keeps a run that never ended.
		await closeOpenRun('success');
		// Force a full reload to pick up the new web app
		setTimeout(() => {
			window.location.reload();
		}, 2_000);
	}

	/**
	 * The updater applied the release but not every service became healthy in
	 * time. Recorded as a success carrying the note: the release is live.
	 * No reload — it would take the explanation off the screen.
	 */
	function onUpdateStarted(summary: string) {
		updateState.value = 'started';
		updateWarning.value = summary;
		void closeOpenRun('success', summary);
	}

	function onUpdateFailed(error: string) {
		updateState.value = 'failed';
		updateError.value = error;
		void closeOpenRun('failed', error);
	}

	return {
		updateState,
		updateSteps,
		updateError,
		updateWarning,
		updateAttempt,
		updateInProgress,
		pendingTargetVersion,
		startUpdate,
		cancelConfirm,
		confirmUpdate,
		onUpdateComplete,
		onUpdateStarted,
		onUpdateFailed,
	};
}
