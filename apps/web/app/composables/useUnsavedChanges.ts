import { nextTick, readonly, ref, onMounted, onUnmounted, type Ref } from 'vue';
import { onBeforeRouteLeave, useRouter, type RouteLocationRaw } from 'vue-router';

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
}

/**
 * Composable for managing unsaved changes warnings and route guards.
 * Shows a confirmation dialog when users try to navigate away with unsaved changes.
 */
export function useUnsavedChanges(options: UseUnsavedChangesOptions = {}): UseUnsavedChangesReturn {
	const router = useRouter();
	const showDialog = ref(false);
	const hasUnsavedChanges = ref(false);
	const pendingRoute = ref<RouteLocationRaw | null>(null);
	const isSavingBeforeLeave = ref(false);

	// Every leave request is its own decision. Cancel, Discard, a newer leave
	// request and unmounting each retire the current one, so a Save that
	// settles afterwards finds its decision gone and does not navigate.
	let decision = 0;

	const retireDecision = () => {
		decision += 1;
		showDialog.value = false;
		pendingRoute.value = null;
	};

	// Handle browser/tab close warning
	const handleBeforeUnload = (e: BeforeUnloadEvent) => {
		if (hasUnsavedChanges.value) {
			e.preventDefault();
			e.returnValue = '';
			return '';
		}
	};

	onMounted(() => {
		window.addEventListener('beforeunload', handleBeforeUnload);
	});

	onUnmounted(() => {
		window.removeEventListener('beforeunload', handleBeforeUnload);
		decision += 1;
	});

	// Vue Router navigation guard
	onBeforeRouteLeave((to, _from, next) => {
		if (hasUnsavedChanges.value) {
			// Store the target route and show dialog
			decision += 1;
			pendingRoute.value = to.fullPath;
			showDialog.value = true;
			next(false);
		} else {
			next();
		}
	});

	const navigate = (route: RouteLocationRaw | null) => {
		retireDecision();
		hasUnsavedChanges.value = false;
		if (route) {
			router.push(route);
		}
	};

	const confirmDiscard = () => {
		// The draft is already being written; leaving without it is back on
		// offer once that write settles.
		if (isSavingBeforeLeave.value) return;
		navigate(pendingRoute.value);
	};

	const confirmSave = async () => {
		// One submission per decision: a repeated click while it runs is ignored.
		if (isSavingBeforeLeave.value) return;
		const route = pendingRoute.value;
		if (!options.onSave) {
			navigate(route);
			return;
		}

		const submittedFor = decision;
		isSavingBeforeLeave.value = true;
		try {
			await options.onSave();
			// Owners mirror their dirty state through watchers; let them report
			// what the save acknowledged before it is read below.
			await nextTick();
		} finally {
			isSavingBeforeLeave.value = false;
		}

		// Cancelled, replaced by a newer leave request, or the page unmounted.
		if (submittedFor !== decision) return;
		// Edited while the save ran: the newer draft is unsaved, so the dialog
		// stays up and asks again about it.
		if (hasUnsavedChanges.value) return;
		navigate(route);
	};

	const cancelNavigation = () => {
		// Only the navigation is cancelled; a save already in flight carries on.
		retireDecision();
	};

	const setHasChanges = (value: boolean) => {
		hasUnsavedChanges.value = value;
	};

	return {
		showDialog,
		hasUnsavedChanges,
		pendingRoute,
		isSavingBeforeLeave: readonly(isSavingBeforeLeave),
		confirmDiscard,
		confirmSave,
		cancelNavigation,
		setHasChanges,
	};
}
