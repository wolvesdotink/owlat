/**
 * Where the app-wide composer overlay lives, and what it can learn from the
 * page it opens over.
 *
 * The top-bar "Compose email" used to navigate to the Postbox and open the
 * composer there, so composing from a contact or from Today cost you the page
 * you were on. The composer is now an overlay on the current page: the shell
 * mounts the same floating composer stack the Postbox uses, and this module
 * decides two things for it, both pure so they are unit-testable:
 *
 *   - which routes already mount their OWN stack (the Postbox reader pages and
 *     the Answer queue), where the shell must stay out of the way so a
 *     composer is not drawn twice;
 *   - what a composer opened on this route should be addressed to — on a
 *     contact page, that contact.
 */

/**
 * Routes whose page mounts `<PostboxComposerStack />` itself. Kept exact: a
 * Postbox page that does NOT host a stack (files, subscriptions, migrate) must
 * get the shell's, or Compose would open nothing there.
 */
const PAGE_HOSTED_STACK_PATTERNS: readonly RegExp[] = [
	/^\/dashboard\/answer$/,
	/^\/dashboard\/postbox\/contacts$/,
	/^\/dashboard\/postbox\/search$/,
	/^\/dashboard\/postbox\/label\/[^/]+$/,
	// A folder list and an open message. The one-segment Postbox pages that are
	// not folders are listed so they fall through to the shell's stack.
	/^\/dashboard\/postbox\/(?!(?:files|subscriptions|migrate|reply-queue|contacts|search|label)$)[^/]+$/,
	/^\/dashboard\/postbox\/(?!label\/)[^/]+\/[^/]+$/,
];

/** True when the page on `path` renders its own composer stack. Pure. */
export function pageHostsComposerStack(path: string): boolean {
	const normalized = path.length > 1 ? path.replace(/\/+$/, '') : path;
	return PAGE_HOSTED_STACK_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** What a composer opened on a route should be addressed to. */
type ComposeContext = { kind: 'contact'; contactId: string };

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
	return null;
}
