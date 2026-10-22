import { backendConnectionPhase, type BackendConnectionPhase } from '~/lib/backendConnection';
import { slowOperations } from '~/lib/pendingOperations';

const LABEL_KEYS: Record<NonNullable<BackendConnectionPhase>, string> = {
	connecting: 'shared.backendStatus.connecting',
	reconnecting: 'shared.backendStatus.reconnecting',
	updating: 'shared.backendStatus.updating',
};

const HINT_KEYS: Record<NonNullable<BackendConnectionPhase>, string> = {
	connecting: 'shared.backendStatus.connectingHint',
	reconnecting: 'shared.backendStatus.reconnectingHint',
	updating: 'shared.backendStatus.updatingHint',
};

/**
 * The backend's reachability and the writes still waiting on it, as the shell
 * shows them. Every surface reads the same module state (`~/lib/backendConnection`,
 * `~/lib/pendingOperations`), so the sidebar footer, the desktop titlebar and
 * the slow-save notice can never disagree.
 */
export function useBackendStatus() {
	const { t } = useI18n();
	const phase = backendConnectionPhase;
	/** Short status for the indicator ("Reconnecting…"); empty while connected. */
	const label = computed(() => (phase.value ? t(LABEL_KEYS[phase.value]) : ''));
	/** The sentence behind it: what is happening and what happens to changes. */
	const hint = computed(() => (phase.value ? t(HINT_KEYS[phase.value]) : ''));
	return { phase, label, hint, slowOperations };
}
