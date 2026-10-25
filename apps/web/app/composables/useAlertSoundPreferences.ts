import { api } from '@owlat/api';
import type { AlertSoundKind, AlertSoundPrefs } from '~/lib/alertSoundRules';
import { alertSoundPatch, resolveAlertSoundPrefs } from '~/lib/alertSoundRules';
import { optimisticUpdateAlertSoundSettings } from '~/lib/mailOptimistic/settingsUpdater';

/**
 * The alert sound switches: read from the person's settings row through the
 * soft-auth `mail.settings.get`, written through `preferences.alertSounds.update`.
 * Not through `usePostboxSettings`' mail write, which needs personal mail: the
 * assignment and agent-question sounds belong to the Team inbox, and an
 * instance with only that on must be able to save them.
 */
export function useAlertSoundPreferences() {
	const { t } = useI18n();
	const { data, isLoading } = useConvexQuery(api.mail.settings.get, () => ({}));
	const alertSounds = computed<AlertSoundPrefs>(() => resolveAlertSoundPrefs(data.value));

	// The switch repaints from the patched row at once; a refused save drops
	// the patch and toasts.
	const saveOp = useBackendOperation(api.preferences.alertSounds.update, {
		label: () => t('components.postbox.postboxAlertSoundSettings.saveOperation'),
		optimisticUpdate: optimisticUpdateAlertSoundSettings,
	});

	async function setAlertSound(kind: AlertSoundKind, enabled: boolean): Promise<void> {
		await saveOp.run(alertSoundPatch(kind, enabled));
	}

	return { alertSounds, setAlertSound, isSaving: saveOp.isLoading, isLoading };
}
