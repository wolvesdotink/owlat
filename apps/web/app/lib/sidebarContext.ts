/**
 * Pure model for the sidebar's Conversations ↔ Sending context toggle.
 *
 * The sidebar renders one *context* (workspace) at a time so it stays focused
 * on what the user is currently doing: Conversations (Today, the Answer queue,
 * every inbox, Chat, Knowledge) or Sending, which holds two zones, Marketing
 * (Overview, Campaigns, Automations) and Transactional (the API-triggered
 * emails), above the Audience and Templates they share. Assistant and Settings
 * are shared — owned by neither, reached from the sidebar footer and ⌘K rather
 * than listed in either.
 *
 * The route is the source of truth: landing anywhere inside a context's route
 * subtree activates that context; shared routes are sticky and keep the last
 * one. The reactive wiring lives in `useSidebarContext`; the mapping and
 * switch-target resolution live here as pure functions so they can be
 * unit-tested without mounting anything (see __tests__/sidebarContext.test.ts).
 */
import { isRecord } from '@owlat/shared/utils/guards';
import type { SectionKey } from '~/composables/useSidebarState';
import { minRole, transactionalGate, type NavigationEnvironment } from './dashboardNavigationCore';

/**
 * `marketing` is the Sending workspace. The key is what localStorage holds
 * (`sidebar-context`, `sidebar-context-routes`), so renaming it would send
 * every returning user back to Conversations and drop their last route there.
 */
export type SidebarContext = 'inbox' | 'marketing';

export const SIDEBAR_CONTEXTS: readonly SidebarContext[] = ['inbox', 'marketing'];

/**
 * The stored last-visited route per context, as `useLocalStorage` reads it:
 * a context this build does not have, or a route that is not a string, is dropped.
 */
export function readLastVisitedRoutes(
	stored: unknown
): Partial<Record<SidebarContext, string>> | undefined {
	if (!isRecord(stored)) return undefined;
	const routes: Partial<Record<SidebarContext, string>> = {};
	for (const context of SIDEBAR_CONTEXTS) {
		const route = stored[context];
		if (typeof route === 'string') routes[context] = route;
	}
	return routes;
}

/**
 * Which context each sidebar section belongs to. Total over SectionKey so the
 * compiler forces every new section to declare its home.
 */
const SECTION_CONTEXT: Record<SectionKey, SidebarContext | 'shared'> = {
	inbox: 'inbox',
	postbox: 'inbox',
	chat: 'inbox',
	assistant: 'shared',
	send: 'marketing',
	transactional: 'marketing',
	audience: 'marketing',
	knowledge: 'inbox',
	administration: 'shared',
	preferences: 'shared',
};

/**
 * Route subtrees owned by each context. Kept as static prefixes (rather than
 * derived from nav item hrefs) because a context owns its whole subtree —
 * `/dashboard/campaigns/new` is Marketing even though no nav item points at it.
 */
const CONTEXT_ROUTE_PREFIXES: Record<SidebarContext, string[]> = {
	inbox: [
		'/dashboard/inbox',
		'/dashboard/inboxes',
		'/dashboard/answer',
		'/dashboard/postbox',
		'/dashboard/chat',
		'/dashboard/knowledge',
		'/dashboard/files',
	],
	marketing: [
		'/dashboard/marketing',
		'/dashboard/campaigns',
		'/dashboard/automations',
		'/dashboard/send',
		'/dashboard/audience',
	],
};

/**
 * Where a context lands when it has no last-visited route yet: the first of
 * these that survived feature-flag filtering, otherwise the first visible item
 * of the context. Sending tries the Marketing overview, then the transactional
 * list, so an instance with only transactional emails does not land on
 * Templates.
 */
const PREFERRED_CONTEXT_HOMES: Record<SidebarContext, readonly string[]> = {
	inbox: ['/dashboard'],
	marketing: ['/dashboard/marketing', '/dashboard/send/transactional'],
};

/**
 * Routes a context owns EXACTLY (not as a subtree). Today (`/dashboard`) is
 * the Conversations home, but a prefix rule would claim the whole app.
 */
const CONTEXT_EXACT_ROUTES: Record<SidebarContext, string[]> = {
	inbox: ['/dashboard'],
	marketing: [],
};

/** Homes that exist for every viewer, so they never need a nav item to be valid. */
const UNGATED_HOMES = new Set(['/dashboard']);

const ownsPath = (prefix: string, path: string) => path === prefix || path.startsWith(`${prefix}/`);

/**
 * The context that owns a route, or null for shared routes (Dashboard,
 * Assistant, Knowledge, Settings…). Accepts full paths — query/hash are
 * ignored.
 */
export function contextForPath(fullPath: string): SidebarContext | null {
	const path = fullPath.split(/[?#]/, 1)[0] ?? fullPath;
	for (const context of SIDEBAR_CONTEXTS) {
		if (CONTEXT_EXACT_ROUTES[context].includes(path)) return context;
		if (CONTEXT_ROUTE_PREFIXES[context].some((prefix) => ownsPath(prefix, path))) {
			return context;
		}
	}
	return null;
}

export interface SplitSections<T> {
	inbox: T[];
	marketing: T[];
	shared: T[];
}

/** Partition nav sections by ownership, preserving their relative order. */
export function splitSectionsByContext<T extends { key: SectionKey }>(
	sections: T[]
): SplitSections<T> {
	const split: SplitSections<T> = { inbox: [], marketing: [], shared: [] };
	for (const section of sections) {
		split[SECTION_CONTEXT[section.key]].push(section);
	}
	return split;
}

/**
 * Where switching to `target` should navigate: its last-visited route if that
 * route still belongs to the target context, else the preferred home when the
 * flags kept it, else the first visible item of the context.
 */
export function resolveSwitchTarget(
	target: SidebarContext,
	lastVisited: string | undefined,
	sections: Array<{ key: SectionKey; items: Array<{ href: string }> }>
): string {
	if (lastVisited && contextForPath(lastVisited) === target) return lastVisited;
	const hrefs = sections
		.filter((section) => SECTION_CONTEXT[section.key] === target)
		.flatMap((section) => section.items.map((item) => item.href));
	const preferred = PREFERRED_CONTEXT_HOMES[target].find(
		(home) => UNGATED_HOMES.has(home) || hrefs.includes(home)
	);
	return preferred ?? hrefs[0] ?? '/dashboard';
}

/** Which zones the Sending sidebar shows, and whether it names them. */
export interface SendingZones {
	/** Overview, the Campaigns group and the Automations group. */
	marketing: boolean;
	/** The latest transactional emails. */
	transactional: boolean;
	/**
	 * Zone labels only separate two zones. With one, the label would head a
	 * list that has nothing to be told apart from, so the rail stays flat.
	 */
	labelled: boolean;
}

/**
 * The zones of the Sending sidebar, with the gates of the destinations they
 * list: Campaigns behind its flag for everyone, Automations and Transactional
 * for admins behind theirs.
 */
export function sendingZones(env: NavigationEnvironment): SendingZones {
	const marketing =
		env.isFeatureEnabled('campaigns') ||
		(minRole('admin')(env) && env.isFeatureEnabled('automations'));
	const transactional = transactionalGate(env);
	return { marketing, transactional, labelled: marketing && transactional };
}
