/**
 * Pure model for the sidebar's Inbox ↔ Marketing context toggle.
 *
 * The sidebar renders one *context* (workspace) at a time so it stays focused
 * on what the user is currently doing: Conversations (Today, the Answer queue,
 * every inbox, Chat, Knowledge) or Marketing (Overview, Campaigns, Automations,
 * Audience, Templates). Assistant and Settings are shared — owned by neither,
 * reached from the sidebar footer and ⌘K rather than listed in either.
 *
 * The route is the source of truth: landing anywhere inside a context's route
 * subtree activates that context; shared routes are sticky and keep the last
 * one. The reactive wiring lives in `useSidebarContext`; the mapping and
 * switch-target resolution live here as pure functions so they can be
 * unit-tested without mounting anything (see __tests__/sidebarContext.test.ts).
 */
import type { SectionKey } from '~/composables/useSidebarState';

export type SidebarContext = 'inbox' | 'marketing';

const SIDEBAR_CONTEXTS: readonly SidebarContext[] = ['inbox', 'marketing'];

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
 * Where a context lands when it has no last-visited route yet, provided the
 * destination survived feature-flag filtering; otherwise the first visible
 * item of the context wins.
 */
const PREFERRED_CONTEXT_HOME: Record<SidebarContext, string> = {
	inbox: '/dashboard',
	marketing: '/dashboard/marketing',
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
	const preferred = PREFERRED_CONTEXT_HOME[target];
	if (UNGATED_HOMES.has(preferred) || hrefs.includes(preferred)) return preferred;
	return hrefs[0] ?? '/dashboard';
}
