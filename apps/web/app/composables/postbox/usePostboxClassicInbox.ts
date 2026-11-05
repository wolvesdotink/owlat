/**
 * The classic inbox switch (`mailUserSettings.isClassicInboxOn`): Priority and
 * All mail instead of the People view. Off unless the person turned it on in
 * Settings, so People is the inbox for everyone else, including people whose
 * settings remember a classic mode from before People existed.
 *
 * Its own composable on the shared settings read (the Convex client keeps one
 * subscription), because usePostboxSettings sits at the file-size cap.
 */

import { api } from '@owlat/api';
import { optimisticUpdateSettings } from '~/lib/mailOptimistic/settingsUpdater';

export function usePostboxClassicInbox() {
	const { t } = useI18n();
	const { data, isLoading } = useConvexQuery(api.mail.settings.get, () => ({}));
	const isClassicInbox = computed<boolean>(() => data.value?.isClassicInboxOn === true);
	const op = useBackendOperation(api.mail.settings.update, {
		label: () => t('components.postbox.classicInbox.operation'),
		optimisticUpdate: optimisticUpdateSettings,
	});

	/** Resolves to whether the save landed. */
	async function setClassicInbox(isOn: boolean): Promise<boolean> {
		return (await op.run({ isClassicInboxOn: isOn })).ok;
	}

	/** Leave People for one classic view, in one save. */
	async function openClassic(mode: 'today' | 'browse'): Promise<boolean> {
		return (await op.run({ isClassicInboxOn: true, inboxMode: mode })).ok;
	}

	return { isClassicInbox, isLoading, setClassicInbox, openClassic };
}
