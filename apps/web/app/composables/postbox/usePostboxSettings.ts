/**
 * Per-user Postbox behavior preferences (api.mail.settings).
 *
 * Currently one preference: `autoAdvance` — what the reader does after the
 * open message is triaged away (archive / trash / snooze / spam). Reads
 * default to 'next' while loading or when the user has never saved a row,
 * so the reader can consume the value unconditionally.
 */

import { api } from '@owlat/api';
import type { PostboxAutoAdvanceMode } from '~/utils/postboxAutoAdvance';
import { POSTBOX_AUTO_ADVANCE_DEFAULT } from '~/utils/postboxAutoAdvance';

export function usePostboxSettings() {
	const { data, isLoading } = useConvexQuery(api.mail.settings.get, () => ({}));

	const autoAdvance = computed<PostboxAutoAdvanceMode>(
		() => data.value?.autoAdvance ?? POSTBOX_AUTO_ADVANCE_DEFAULT
	);

	const updateOp = useBackendOperation(api.mail.settings.update, {
		label: 'Save Postbox settings',
	});

	async function setAutoAdvance(mode: PostboxAutoAdvanceMode) {
		await updateOp.run({ autoAdvance: mode });
	}

	return { autoAdvance, isLoading, setAutoAdvance, isSaving: updateOp.isLoading };
}
