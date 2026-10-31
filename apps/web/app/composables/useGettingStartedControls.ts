import { api } from '@owlat/api';
import { computed, shallowRef, watch } from 'vue';
import type { DismissalScope } from '~/utils/gettingStarted';
import { useZenMode } from '~/composables/useZenMode';
import { waitForLoaded } from '~/utils/waitForLoaded';

/** Where the full Getting started card lives. */
const TODAY_PATH = '/dashboard';

/** How long Undo stays offered: long enough to read the toast and reach the button. */
const UNDO_TOAST_MS = 8000;

/**
 * The person's latest decision about the checklist's visibility, app-wide.
 *
 * - `owner` is the user who made it. Another signed-in user never sees it, and
 *   any change of user wipes it, so one person's "show" never opens the card
 *   for the next person on the same tab.
 * - `asks` counts explicit requests to see the checklist (palette, account
 *   menu) since the last dismissal. Every ask bumps it so the card re-expands
 *   and scrolls even when already open. While it is non-zero the Today card
 *   shows even a finished or dismissed checklist (see `reopened` in
 *   `~/utils/gettingStarted`).
 * - `generation` advances on every show, dismiss, Undo and change of user.
 *   Each of them is async; a completion acts only while its generation is
 *   still the latest, so a slow dismissal cannot hide a card the person asked
 *   to see again after it, and a slow show cannot restore a card dismissed
 *   after it.
 *
 * Module state because the palette, the account menu and the card live in
 * different trees. A reload drops it, and the card then follows the stored
 * dismissal and completion again.
 */
interface VisibilityIntent {
	owner: string | null;
	asks: number;
	generation: number;
}
const intent = shallowRef<VisibilityIntent>({ owner: null, asks: 0, generation: 0 });

/** Record a new decision by `owner` and return its generation. */
function decide(owner: string | null, asks: (current: number) => number): number {
	const previous = intent.value;
	const current = previous.owner === owner ? previous.asks : 0;
	const generation = previous.generation + 1;
	intent.value = { owner, asks: asks(current), generation };
	return generation;
}

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
	const { isAdmin, isRoleLoading } = usePermissions();
	const { isZen, exitZen } = useZenMode();
	const route = useRoute();

	const currentUserId = computed(() => user.value?.id ?? null);

	// A different person (or nobody) is signed in now: their checklist starts
	// from the stored state, and every pending completion of the previous
	// person's decisions goes stale.
	watch(
		currentUserId,
		(userId) => {
			if (intent.value.owner !== null && intent.value.owner !== userId) decide(null, () => 0);
		},
		{ immediate: true }
	);

	const reopenRequest = computed(() =>
		intent.value.owner !== null && intent.value.owner === currentUserId.value
			? intent.value.asks
			: 0
	);

	/** The decision made at `generation` by `userId` is still the latest one. */
	function isLatest(generation: number, userId: string): boolean {
		return intent.value.generation === generation && currentUserId.value === userId;
	}

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
		wasReopened: boolean,
		dismissedIn: number
	): Promise<boolean> {
		// The toast outlived the session that dismissed: nothing of theirs to undo.
		if (currentUserId.value !== userId) return false;
		const restored = await Promise.all(
			landed.map(({ scope, dismissedAt }) => restoreIn(scope, userId, dismissedAt))
		);
		const isUndone = restored.every(Boolean);
		// A checklist that was only showing because it was asked for (finished, say)
		// comes back the way it was, unless the person decided something since.
		if (isUndone && wasReopened && isLatest(dismissedIn, userId)) decide(userId, () => 1);
		return isUndone;
	}

	async function dismiss(scope: DismissalScope, userId: string): Promise<void> {
		const scopes: LandedDismissal['scope'][] = [];
		if (scope === 'instance' || scope === 'both') scopes.push('instance');
		if (scope === 'user' || scope === 'both') scopes.push('user');
		if (scopes.length === 0) return;

		const wasReopened = reopenRequest.value > 0;
		const generation = decide(userId, (asks) => asks);
		const outcomes = await Promise.all(scopes.map((s) => dismissIn(s, userId)));
		const landed = outcomes.filter((o): o is LandedDismissal => o !== null);
		// Nothing landed: each failure has already said so, and the card stays.
		if (landed.length === 0) return;
		// Asked to show it again (or signed out) while this was in flight: the
		// newer decision stands, and there is nothing hidden to announce.
		if (!isLatest(generation, userId)) return;

		const dismissedIn = decide(userId, () => 0);
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
				run: () => undo(userId, landed, wasReopened, dismissedIn),
			},
		});
	}

	async function showChecklist(): Promise<void> {
		const userId = currentUserId.value;
		if (!userId) return;
		const generation = decide(userId, (asks) => asks + 1);
		if (isZen.value) exitZen();
		const navigation = route.path !== TODAY_PATH ? navigateTo(TODAY_PATH) : undefined;
		// Pages render before the member role resolves. Which dismissals may be
		// cleared depends on it, so wait rather than treat an admin as a member
		// and leave the instance dismissal in place.
		await waitForLoaded(isRoleLoading);
		await navigation;
		// Dismissed again, or another person signed in, while waiting: restoring
		// now would overturn that.
		if (!isLatest(generation, userId)) return;
		const restores = [restoreIn('user', userId)];
		if (isAdmin.value) restores.push(restoreIn('instance', userId));
		await Promise.all(restores);
	}

	return { reopenRequest, dismiss, showChecklist };
}
