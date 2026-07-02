/**
 * Per-user Postbox behavior preferences (api.mail.settings).
 *
 * Preferences:
 *   - `autoAdvance` — what the reader does after the open message is triaged
 *     away (archive / trash / snooze / spam). Reads default to 'next' while
 *     loading or when the user has never saved a row, so the reader can consume
 *     the value unconditionally.
 *   - `writingSuggestions` — inline ghost-text autocomplete in the composer.
 *     Defaults ON (undefined => true) so it's on by default wherever the `ai`
 *     feature flag is enabled; the flag itself is the master gate.
 */

import { api } from '@owlat/api';
import type { PostboxAutoAdvanceMode } from '~/utils/postboxAutoAdvance';
import { POSTBOX_AUTO_ADVANCE_DEFAULT } from '~/utils/postboxAutoAdvance';

export function usePostboxSettings() {
	const { data, isLoading } = useConvexQuery(api.mail.settings.get, () => ({}));

	const autoAdvance = computed<PostboxAutoAdvanceMode>(
		() => data.value?.autoAdvance ?? POSTBOX_AUTO_ADVANCE_DEFAULT
	);

	// Default ON: an unset preference means "use suggestions" — the `ai` flag is
	// the real on/off switch, this is a user opt-out within an AI-enabled deploy.
	const writingSuggestions = computed<boolean>(
		() => data.value?.isWritingSuggestionsOn ?? true
	);

	const updateOp = useBackendOperation(api.mail.settings.update, {
		label: 'Save Postbox settings',
	});

	async function setAutoAdvance(mode: PostboxAutoAdvanceMode) {
		await updateOp.run({ autoAdvance: mode });
	}

	async function setWritingSuggestions(enabled: boolean) {
		await updateOp.run({ isWritingSuggestionsOn: enabled });
	}

	return {
		autoAdvance,
		writingSuggestions,
		isLoading,
		setAutoAdvance,
		setWritingSuggestions,
		isSaving: updateOp.isLoading,
	};
}
