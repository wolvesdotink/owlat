/**
 * The seeded shared inbox the Postbox surfaces open. Import-free, because the
 * app's own rail test checks the matcher against the rendered rail and the
 * app's type check must not pull in the capture tool's Node and Playwright
 * modules.
 */

export const SHARED_INBOX = 'Team';

/**
 * How the Team inbox's entry in the mailbox rail is found: a link to its
 * mailbox whose accessible name is the inbox name, alone or with its unread
 * count ("Team, 3 unread"). The collapsed rail names its entries through
 * `aria-label` only, and the "Team inbox" entry links elsewhere.
 */
export const SHARED_INBOX_RAIL_ENTRY = {
	hrefPrefix: '/dashboard/postbox/inbox?mailbox=',
	name: new RegExp(`^${SHARED_INBOX}(?:,|$)`),
} as const;
