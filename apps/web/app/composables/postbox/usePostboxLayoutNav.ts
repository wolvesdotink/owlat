/**
 * The two route moves PostboxLayout makes on its own, lifted out of that file to
 * keep it under the size cap. Both are REPLACE navigations, and for the same
 * reason: neither is a place the user asked to be taken to, so neither should
 * grow the history stack.
 */

import type { Id } from '@owlat/api/dataModel';

export function usePostboxLayoutNav(args: {
	folderRole: Ref<string>;
	folderId: Ref<Id<'mailFolders'> | undefined>;
	activeMessageId: Ref<string | null | undefined>;
}) {
	/**
	 * Drill-in "back": from the reader to the folder's list route. Replace, don't
	 * push — opening the message pushed the entry this button dismisses, so a push
	 * here would leave the system Back gesture reopening the reader the user just
	 * closed, and grow the history stack by two entries per open/close cycle.
	 */
	function backToList() {
		void navigateTo(`/dashboard/postbox/${String(args.folderId.value ?? args.folderRole.value)}`, {
			replace: true,
		});
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
