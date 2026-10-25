import { computed, nextTick, ref, onUnmounted, type Ref } from 'vue';
import { onBeforeRouteLeave, useRouter, type RouteLocationRaw } from 'vue-router';
import { usePageExitGuard } from '~/composables/usePageExitGuard';
import type { DraftLeaveDecisions } from '~/composables/useDraftLeave';

export interface UseUnsavedChangesReturn {
	showDialog: Ref<boolean>;
	hasUnsavedChanges: Ref<boolean>;
	pendingRoute: Ref<RouteLocationRaw | null>;
	/** A Save chosen in the dialog is in flight. Bind to the dialog's `saving`. */
	isSavingBeforeLeave: Readonly<Ref<boolean>>;
	confirmDiscard: () => void;
	confirmSave: () => Promise<void>;
	cancelNavigation: () => void;
	setHasChanges: (value: boolean) => void;
}

export interface UseUnsavedChangesOptions {
	/**
	 * Persist the draft. Throw when it did not land, which keeps the dialog and
	 * the edits. When it lands, the owner's dirty feed (`setHasChanges`) decides
	 * whether anything is still unsaved: an edit made while the save was in
	 * flight keeps the page dirty, and the guard stays instead of leaving.
	 */
	onSave?: () => Promise<void>;
	/**
	 * A draft's autosave session, which decides leaving itself
	 * (`useDraftAutosave`'s `leave`). While this returns one, the route guard,
	 * the dialog and the browser's warning follow its decisions; `onSave` and
	 * `setHasChanges` are not consulted.
	 */
	decisions?: () => DraftLeaveDecisions | null;
}

/**
 * Composable for managing unsaved changes warnings and route guards.
 * Shows a confirmation dialog when users try to navigate away with unsaved changes.
 */
export function useUnsavedChanges(options: UseUnsavedChangesOptions = {}): UseUnsavedChangesReturn {
	const router = useRouter();
	const dialog = ref(false);
	const hasUnsavedChanges = ref(false);
	const route = ref<RouteLocationRaw | null>(null);
	const saving = ref(false);
	const owner = () => options.decisions?.() ?? null;

	// Every leave request is its own decision. Cancel, Discard, a newer leave
	// request and unmounting each retire the current one, so a Save that
	// settles afterwards finds its decision gone and does not navigate.
	let decision = 0;

	const retireDecision = () => {
		decision += 1;
		dialog.value = false;
		route.value = null;
	};

	// The browser asks before the tab closes, and an app update does not reload over the edits.
	usePageExitGuard(() => owner()?.isAtRisk() ?? hasUnsavedChanges.value);

	onUnmounted(() => {
		decision += 1;
	});

	// Vue Router navigation guard
	onBeforeRouteLeave(async (to, _from, next) => {
		const decisions = owner();
		if (decisions) {
			next((await decisions.request(to.fullPath)) ? undefined : false);
			return;
		}
		if (hasUnsavedChanges.value) {
			// Store the target route and show dialog
			decision += 1;
			route.value = to.fullPath;
			dialog.value = true;
			next(false);
		} else {
			next();
		}
	});

	const navigate = (target: RouteLocationRaw | null) => {
		retireDecision();
		hasUnsavedChanges.value = false;
		if (target) {
			router.push(target);
		}
	};

	const confirmDiscard = () => {
		const decisions = owner();
		if (decisions) {
			const target = decisions.discard();
			if (target) void router.push(target);
			return;
		}
		// The draft is already being written; leaving without it is back on
		// offer once that write settles.
		if (saving.value) return;
		navigate(route.value);
	};

	const confirmSave = async () => {
		const decisions = owner();
		if (decisions) {
			const target = await decisions.save();
			if (target) void router.push(target);
			return;
		}
		// One submission per decision: a repeated click while it runs is ignored.
		if (saving.value) return;
		const target = route.value;
		if (!options.onSave) {
			navigate(target);
			return;
		}

		const submittedFor = decision;
		saving.value = true;
		try {
			await options.onSave();
			// Owners mirror their dirty state through watchers; let them report
			// what the save acknowledged before it is read below.
			await nextTick();
		} finally {
			saving.value = false;
		}

		// Cancelled, replaced by a newer leave request, or the page unmounted.
		if (submittedFor !== decision) return;
		// Edited while the save ran: the newer draft is unsaved, so the dialog
		// stays up and asks again about it.
		if (hasUnsavedChanges.value) return;
		navigate(target);
	};

	const cancelNavigation = () => {
		const decisions = owner();
		// Only the navigation is cancelled; a save already in flight carries on.
		if (decisions) decisions.cancel();
		else retireDecision();
	};

	const setHasChanges = (value: boolean) => {
		hasUnsavedChanges.value = value;
	};

	return {
		showDialog: computed({
			get: () => owner()?.choosing.value ?? dialog.value,
			set: (open) => {
				const decisions = owner();
				if (!decisions) dialog.value = open;
				else if (!open) decisions.cancel();
			},
		}),
		hasUnsavedChanges,
		pendingRoute: computed({
			get: () => owner()?.destination.value ?? route.value,
			set: (target) => {
				route.value = target;
			},
		}),
		isSavingBeforeLeave: computed(() => owner()?.saving.value ?? saving.value),
		confirmDiscard,
		confirmSave,
		cancelNavigation,
		setHasChanges,
	};
}
