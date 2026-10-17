/**
 * The two route moves PostboxLayout makes on its own, lifted out of that file to
 * keep it under the size cap. Both are REPLACE navigations, and for the same
 * reason: neither is a place the user asked to be taken to, so neither should
 * grow the history stack.
 */

import type { Id } from '@owlat/api/dataModel';
import {
	parsePlacementQuery,
	placementQuerySuffix,
} from '~/composables/postbox/usePostboxPlacementFilter';

export function usePostboxLayoutNav(args: {
	folderRole: Ref<string>;
	folderId: Ref<Id<'mailFolders'> | undefined>;
	activeMessageId: Ref<string | null | undefined>;
}) {
	// Back to a filtered list (`?placement=`, read on arrival §3) keeps the filter.
	const route = useRoute();
	/**
	 * Drill-in "back": from the reader to the folder's list route. Replace, don't
	 * push — opening the message pushed the entry this button dismisses, so a push
	 * here would leave the system Back gesture reopening the reader the user just
	 * closed, and grow the history stack by two entries per open/close cycle.
	 */
	function backToList() {
		const folder = String(args.folderId.value ?? args.folderRole.value);
		const query = placementQuerySuffix(parsePlacementQuery(route.query['placement']));
		void navigateTo(`/dashboard/postbox/${folder}${query}`, { replace: true });
	}

	/**
	 * The Today overlay closed while the route still points at a deep-linked
	 * message — settle the URL back on the plain inbox (replace: the overlay was
	 * never its own history entry when opened from the list).
	 */
	function onTodayReaderClosed() {
		if (args.activeMessageId.value) {
			void navigateTo('/dashboard/postbox/inbox', { replace: true });
		}
	}

	return { backToList, onTodayReaderClosed };
}
