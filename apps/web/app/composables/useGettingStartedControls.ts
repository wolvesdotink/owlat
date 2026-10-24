import { api } from '@owlat/api';
import { readonly, ref } from 'vue';
import type { DismissalScope } from '~/utils/gettingStarted';
import { useZenMode } from '~/composables/useZenMode';

/** Where the full Getting started card lives. */
const TODAY_PATH = '/dashboard';

/** How long Undo stays offered: long enough to read the toast and reach the button. */
const UNDO_TOAST_MS = 8000;

/**
 * Explicit requests to see the setup checklist, app-wide: zero until someone
 * asks (palette, account menu), bumped on every ask so the card re-expands and
 * scrolls even when it is already open, and back to zero once the card is
 * dismissed. While it is non-zero the Today card shows even a finished or
 * dismissed checklist (see `reopened` in `~/utils/gettingStarted`).
 *
 * Module state because the palette, the account menu and the card live in
 * different trees. A reload drops it, and the card then follows the stored
 * dismissal and completion again.
 */
const reopenRequest = ref(0);

/** One dismissal write that landed, with the token its Undo hands back. */
interface LandedDismissal {
	scope: 'instance' | 'user';
	dismissedAt: number;
}

/**
 * The single owner of hiding and bringing back the Getting started checklist.
 *
 * - `dismiss` hides whatever the card shows (the model's dismissal scope) and
 *   offers Undo for the writes that actually landed. The Undo hands each
 *   restore the instant its dismissal returned, so it cannot reverse a
 *   dismissal made later (another tab, another admin).
 * - `showChecklist` is the way back at any time: it clears the stored
 *   dismissals (instance-wide only for admins, the same boundary as dismissing),
 *   leaves Zen, and opens Today with the card expanded, finished or not.
 */
export function useGettingStartedControls() {
	const { t } = useI18n();
	const { showToast } = useToast();
	const { user } = useAuth();
	const { isAdmin } = usePermissions();
	const { isZen, exitZen } = useZenMode();
	const route = useRoute();

	const dismissInstance = useBackendOperation(api.auth.onboarding.dismiss, {
		label: () => t('components.dashboard.gettingStarted.dismissInstanceOperation'),
	});
	const dismissUser = useBackendOperation(api.auth.userOnboarding.dismiss, {
		label: () => t('components.dashboard.gettingStarted.dismissUserOperation'),
	});
	const restoreInstance = useBackendOperation(api.auth.onboarding.restore, {
		label: () => t('components.dashboard.gettingStarted.restoreInstanceOperation'),
	});
	const restoreUser = useBackendOperation(api.auth.userOnboarding.restore, {
		label: () => t('components.dashboard.gettingStarted.restoreUserOperation'),
	});

	async function dismissIn(
		scope: LandedDismissal['scope'],
		userId: string
	): Promise<LandedDismissal | null> {
		const run =
			scope === 'instance'
				? await dismissInstance.run({ userId })
				: await dismissUser.run({ userId });
		return run.ok ? { scope, dismissedAt: run.result.dismissedAt } : null;
	}

	async function restoreIn(
		scope: LandedDismissal['scope'],
		userId: string,
		dismissedAt?: number
	): Promise<boolean> {
		const args = dismissedAt === undefined ? { userId } : { userId, dismissedAt };
		const run =
			scope === 'instance' ? await restoreInstance.run(args) : await restoreUser.run(args);
		return run.ok && !run.result.isDismissed;
	}

	/**
	 * Undo exactly the dismissals that landed. Counts as done only when every one
	 * of them is restored; a refused or failed restore leaves the toast saying so.
	 */
	async function undo(
		userId: string,
		landed: readonly LandedDismissal[],
		wasReopened: boolean
	): Promise<boolean> {
		const restored = await Promise.all(
			landed.map(({ scope, dismissedAt }) => restoreIn(scope, userId, dismissedAt))
		);
		const isUndone = restored.every(Boolean);
		// A checklist that was only showing because it was asked for (finished, say)
		// comes back the way it was.
		if (isUndone && wasReopened) reopenRequest.value += 1;
		return isUndone;
	}

	async function dismiss(scope: DismissalScope, userId: string): Promise<void> {
		const scopes: LandedDismissal['scope'][] = [];
		if (scope === 'instance' || scope === 'both') scopes.push('instance');
		if (scope === 'user' || scope === 'both') scopes.push('user');
		if (scopes.length === 0) return;

		const wasReopened = reopenRequest.value > 0;
		const outcomes = await Promise.all(scopes.map((s) => dismissIn(s, userId)));
		const landed = outcomes.filter((o): o is LandedDismissal => o !== null);
		// Nothing landed: each failure has already said so, and the card stays.
		if (landed.length === 0) return;

		reopenRequest.value = 0;
		const message =
			landed.length === scopes.length
				? t('components.dashboard.gettingStarted.hidden')
				: t('components.dashboard.gettingStarted.partlyHidden');
		showToast(message, 'info', {
			durationMs: UNDO_TOAST_MS,
			observedAction: {
				label: t('common.undo'),
				pendingLabel: t('components.dashboard.gettingStarted.undoing'),
				failedNote: t('components.dashboard.gettingStarted.notUndone'),
				run: () => undo(userId, landed, wasReopened),
			},
		});
	}

	async function showChecklist(): Promise<void> {
		const userId = user.value?.id;
		if (!userId) return;
		reopenRequest.value += 1;
		if (isZen.value) exitZen();
		const restores = [restoreIn('user', userId)];
		if (isAdmin.value) restores.push(restoreIn('instance', userId));
		if (route.path !== TODAY_PATH) await navigateTo(TODAY_PATH);
		await Promise.all(restores);
	}

	return { reopenRequest: readonly(reopenRequest), dismiss, showChecklist };
}
