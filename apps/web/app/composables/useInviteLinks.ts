/**
 * Shared invite accept-link helpers for the Team Management page and its invite
 * modal. Every invitation exposes an accept URL of the form
 * SITE_URL/invite/accept?id=<id>; this is the path that works even when outbound
 * email delivery isn't configured yet. Kept in one place so the page and the
 * modal build and copy the same link and can never drift.
 */
export function useInviteLinks() {
	const requestUrl = useRequestURL();
	const { copy } = useCopyToClipboard();
	const { showToast } = useToast();

	function buildAcceptUrl(invitationId: string): string {
		return `${requestUrl.origin}/invite/accept?id=${encodeURIComponent(invitationId)}`;
	}

	// Copy an invite's accept link to the clipboard, toasting the outcome.
	async function copyLinkText(url: string) {
		const ok = await copy(url);
		showToast(ok ? 'Invite link copied' : 'Could not copy the link', ok ? 'success' : 'error');
	}

	return { buildAcceptUrl, copyLinkText };
}
