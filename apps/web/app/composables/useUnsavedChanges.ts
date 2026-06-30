import { ref, onMounted, onUnmounted, type Ref } from 'vue';
import { onBeforeRouteLeave, useRouter, type RouteLocationRaw } from 'vue-router';

export interface UseUnsavedChangesReturn {
	showDialog: Ref<boolean>;
	hasUnsavedChanges: Ref<boolean>;
	pendingRoute: Ref<RouteLocationRaw | null>;
	confirmDiscard: () => void;
	confirmSave: () => Promise<void>;
	cancelNavigation: () => void;
	setHasChanges: (value: boolean) => void;
}

export interface UseUnsavedChangesOptions {
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
	});

	// Vue Router navigation guard
	onBeforeRouteLeave((to, _from, next) => {
		if (hasUnsavedChanges.value) {
			// Store the target route and show dialog
			pendingRoute.value = to.fullPath;
			showDialog.value = true;
			next(false);
		} else {
			next();
		}
	});

	const confirmDiscard = () => {
		const route = pendingRoute.value;
		showDialog.value = false;
		hasUnsavedChanges.value = false;
		pendingRoute.value = null;

		// Navigate after resetting state
		if (route) {
			router.push(route);
		}
	};

	const confirmSave = async () => {
		const route = pendingRoute.value;

		if (options.onSave) {
			await options.onSave();
		}

		showDialog.value = false;
		hasUnsavedChanges.value = false;
		pendingRoute.value = null;

		// Navigate after saving
		if (route) {
			router.push(route);
		}
	};

	const cancelNavigation = () => {
		showDialog.value = false;
		pendingRoute.value = null;
	};

	const setHasChanges = (value: boolean) => {
		hasUnsavedChanges.value = value;
	};

	return {
		showDialog,
		hasUnsavedChanges,
		pendingRoute,
		confirmDiscard,
		confirmSave,
		cancelNavigation,
		setHasChanges,
	};
}
