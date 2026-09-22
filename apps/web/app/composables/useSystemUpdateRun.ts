import { api } from '@owlat/api';
import { apiFetch } from '~/lib/csrfFetch';
import { updateFailureMessage, updateRequestWasAnswered } from '~/lib/systemUpdate';

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

type UpdateState = 'idle' | 'confirming' | 'running' | 'success' | 'failed';

export function useSystemUpdateRun(latestVersion: () => string | undefined) {
	const { t } = useI18n();
	const convex = useConvex();

	const updateState = ref<UpdateState>('idle');
	const updateSteps = ref<UpdateStep[] | null>(null);
	const updateError = ref<string>('');
	const pendingTargetVersion = ref<string>('');

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

	function startUpdate() {
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
		updateSteps.value = null;

		try {
			const resp = await apiFetch<{ steps?: UpdateStep[] }>('/api/system/update', {
				method: 'POST',
				body: { targetVersion: pendingTargetVersion.value },
				retry: 0,
				// Long timeout for pull+up+convex-deploy
				timeout: 10 * 60 * 1000,
			});
			updateSteps.value = resp.steps ?? null;
			// Don't set success yet — wait for UpdateProgress to confirm new version is live.
		} catch (err) {
			// A throw the server did not put there is the web container being
			// recreated by the update's last step — the progress card keeps the
			// verdict and resolves it from updater health.
			if (!updateRequestWasAnswered(err)) return;
			updateState.value = 'failed';
			updateError.value = updateFailureMessage(err, t('dashboard.admin.system.index.unknownError'));
			void closeOpenRun('failed', updateError.value);
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

	function onUpdateFailed(error: string) {
		updateState.value = 'failed';
		updateError.value = error;
		void closeOpenRun('failed', error);
	}

	return {
		updateState,
		updateSteps,
		updateError,
		pendingTargetVersion,
		startUpdate,
		cancelConfirm,
		confirmUpdate,
		onUpdateComplete,
		onUpdateFailed,
	};
}
