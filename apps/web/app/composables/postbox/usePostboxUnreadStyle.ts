/**
 * How unread rows stand out in the Postbox list (utils/postboxUnreadStyle).
 *
 * It lives in the same `mailUserSettings` row as every other Postbox
 * preference and goes through the same query, mutation and optimistic patch as
 * usePostboxSettings, which sits at the file-size cap. Convex shares one
 * subscription between identical queries, so reading the row here costs no
 * second fetch.
 */
import { api } from '@owlat/api';
import type { PostboxUnreadStyle } from '~/utils/postboxUnreadStyle';
import { resolvePostboxUnreadStyle } from '~/utils/postboxUnreadStyle';
import { optimisticUpdateSettings } from '~/lib/mailOptimistic/settingsUpdater';

export function usePostboxUnreadStyle() {
	const { data } = useConvexQuery(api.mail.settings.get, () => ({}));
	const updateOp = useBackendOperation(api.mail.settings.update, {
		label: 'Save Postbox settings',
		optimisticUpdate: optimisticUpdateSettings,
	});

	// An unset (or unknown) value resolves to 'dot-weight' while the query loads.
	const unreadStyle = computed<PostboxUnreadStyle>(() =>
		resolvePostboxUnreadStyle(data.value?.unreadStyle)
	);

	async function setUnreadStyle(style: PostboxUnreadStyle) {
		await updateOp.run({ unreadStyle: style });
	}

	return { unreadStyle, setUnreadStyle, isSaving: updateOp.isLoading };
}
