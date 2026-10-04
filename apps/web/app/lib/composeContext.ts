/**
 * What a composer opened on the current route should be addressed to — on a
 * contact page, that contact; on a Team inbox thread, the thread itself,
 * answered through its own reply composer. Pure, so it is unit-testable.
 */

/**
 * What Compose should do on a route: address a new composer to a contact, or,
 * on a Team inbox thread, answer that thread in its own reply composer (a
 * personal-mailbox composer would send the reply from the wrong address).
 */
export type ComposeContext =
	| { kind: 'contact'; contactId: string }
	| { kind: 'thread'; threadId: string };

/** A Team inbox thread. The static pages beside it are not threads. */
const THREAD_ROUTE_PATTERN =
	/^\/dashboard\/inbox\/(?!(?:activity|code-tasks|failed|quarantine|review|updates)\/?$)([^/]+)\/?$/;

/** Contact detail pages: the Audience list's and a topic's member view. */
const CONTACT_ROUTE_PATTERNS: readonly RegExp[] = [
	/^\/dashboard\/audience\/contacts\/([^/]+)\/?$/,
	/^\/dashboard\/audience\/topics\/[^/]+\/contacts\/([^/]+)\/?$/,
];

/** The context a new composer can take from `path`, or null. Pure. */
export function composeContextForPath(path: string): ComposeContext | null {
	for (const pattern of CONTACT_ROUTE_PATTERNS) {
		const contactId = pattern.exec(path)?.[1];
		if (contactId) return { kind: 'contact', contactId: decodeURIComponent(contactId) };
	}
	const threadId = THREAD_ROUTE_PATTERN.exec(path)?.[1];
	if (threadId) return { kind: 'thread', threadId: decodeURIComponent(threadId) };
	return null;
}
