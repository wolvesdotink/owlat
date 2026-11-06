import { api } from '@owlat/api';

/** The AI settings page, which says the same in its own card. */
export const AI_SETTINGS_PATH = '/dashboard/admin/instance/ai-provider';

const DISMISSED_KEY = 'owlat.aiKeyRefused.dismissed';

function readDismissed(): number | null {
	try {
		const raw = globalThis.localStorage?.getItem(DISMISSED_KEY);
		return raw ? Number(raw) : null;
	} catch {
		return null;
	}
}

function writeDismissed(firstSeenAt: number): void {
	try {
		globalThis.localStorage?.setItem(DISMISSED_KEY, String(firstSeenAt));
	} catch {
		// Without storage the notice comes back on the next load, which is fine.
	}
}

/**
 * Tells an admin, once per refusal, that the AI provider is refusing the
 * instance's key, with the way to AI settings. Members get nothing: they
 * cannot fix it, and each thread already says AI is unavailable.
 *
 * Closing the notice hides it until the provider refuses again after an
 * accepted call or a saved key (a new `firstSeenAt`). It is not shown on the
 * AI settings page, whose card says the same.
 */
export function useAiKeyRefusedNotice() {
	const { t } = useI18n();
	const route = useRoute();
	const { showToast, removeToast } = useToast();
	const { isAdmin } = usePermissions();

	const { data: refusal } = useOrganizationQuery(api.aiRouting.providerHealth.getAuthFailure, () =>
		isAdmin.value ? {} : undefined
	);

	let toastId: string | null = null;
	let shownFor: number | null = null;

	/** Takes the notice down without counting it as closed by the person. */
	function hide(): void {
		const id = toastId;
		toastId = null;
		shownFor = null;
		if (id) removeToast(id);
	}

	watch(
		[() => (isAdmin.value ? refusal.value?.firstSeenAt : undefined), () => route.path],
		([firstSeenAt, path]) => {
			if (firstSeenAt === undefined || path === AI_SETTINGS_PATH) return hide();
			if (shownFor === firstSeenAt || readDismissed() === firstSeenAt) return;
			hide();
			shownFor = firstSeenAt;
			const id = showToast(t('shared.backendStatus.aiKeyRefused'), 'warning', {
				durationMs: 0,
				action: {
					label: t('shared.backendStatus.aiSettings'),
					onAction: () => void navigateTo(AI_SETTINGS_PATH),
				},
				onDismiss: () => {
					if (toastId !== id) return;
					toastId = null;
					writeDismissed(firstSeenAt);
				},
			});
			toastId = id;
		},
		{ immediate: true }
	);

	onScopeDispose(hide);
}
