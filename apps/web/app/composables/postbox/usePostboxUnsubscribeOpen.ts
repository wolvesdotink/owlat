import type { Id } from '@owlat/api/dataModel';
import { escapeHtmlWithBreaks } from '@owlat/shared/html';
import { parseMailto } from '@owlat/shared/mailto';

/**
 * The manual half of unsubscribing, shared by the reader's Unsubscribe chip
 * and the Senders page: a mailto target opens a prefilled compose when it
 * names at least one To recipient (cc/bcc are ignored); otherwise the https
 * page opens in a new tab. One-click is never handled here: that POST runs
 * server-side.
 */
export function usePostboxUnsubscribeOpen() {
	const composeNav = usePostboxComposeNav();

	/** Returns false when the target offered nothing that could be opened. */
	function openManualUnsubscribe(
		target: { mailtoUrl?: string; httpUrl?: string },
		mailboxId: string
	): boolean {
		if (target.mailtoUrl) {
			const mailto = parseMailto(target.mailtoUrl);
			if (mailto && mailto.to.length > 0) {
				void composeNav.open({
					mailboxId: mailboxId as Id<'mailboxes'>,
					prefillTo: mailto.to,
					prefillSubject: mailto.subject ?? 'Unsubscribe',
					// The header is attacker-controlled — mailto bodies are plain
					// text, so escape before embedding as compose HTML.
					...(mailto.body
						? { prefillBodyHtml: `<p>${escapeHtmlWithBreaks(mailto.body)}</p>` }
						: {}),
				});
				return true;
			}
		}
		if (target.httpUrl) {
			window.open(target.httpUrl, '_blank', 'noopener,noreferrer');
			return true;
		}
		return false;
	}

	return { openManualUnsubscribe };
}
