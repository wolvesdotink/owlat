/**
 * Pure model for the sidebar's Inbox ↔ Marketing context toggle.
 *
 * The sidebar renders one *context* at a time so it stays focused on what the
 * user is currently doing: Inbox (Team Inbox, Postbox, Chat) or Marketing
 * (Send, Audience, Delivery). Dashboard, Assistant, Knowledge and Settings are
 * shared — visible in both contexts and owned by neither.
 *
 * The route is the source of truth: landing anywhere inside a context's route
 * subtree activates that context; shared routes are sticky and keep the last
 * one. The reactive wiring lives in `useSidebarContext`; the mapping and
 * switch-target resolution live here as pure functions so they can be
 * unit-tested without mounting anything (see __tests__/sidebarContext.test.ts).
 */
import type { SectionKey } from '~/composables/useSidebarState';

export type SidebarContext = 'inbox' | 'marketing';

export const SIDEBAR_CONTEXTS: readonly SidebarContext[] = ['inbox', 'marketing'];

/**
 * Which context each sidebar section belongs to. Total over SectionKey so the
 * compiler forces every new section to declare its home.
 */
export const SECTION_CONTEXT: Record<SectionKey, SidebarContext | 'shared'> = {
	inbox: 'inbox',
	postbox: 'inbox',
	chat: 'inbox',
	assistant: 'shared',
	send: 'marketing',
	audience: 'marketing',
	delivery: 'marketing',
	knowledge: 'shared',
	settings: 'shared',
};

/**
 * Route subtrees owned by each context. Kept as static prefixes (rather than
 * derived from nav item hrefs) because a context owns its whole subtree —
 * `/dashboard/campaigns/new` is Marketing even though no nav item points at it.
 */
const CONTEXT_ROUTE_PREFIXES: Record<SidebarContext, string[]> = {
	inbox: ['/dashboard/inbox', '/dashboard/postbox', '/dashboard/chat'],
	marketing: [
		'/dashboard/campaigns',
		'/dashboard/automations',
		'/dashboard/send',
		'/dashboard/audience',
		'/dashboard/delivery',
	],
};

/**
 * Where a context lands when it has no last-visited route yet, provided the
 * destination survived feature-flag filtering; otherwise the first visible
 * item of the context wins.
 */
const PREFERRED_CONTEXT_HOME: Record<SidebarContext, string> = {
	inbox: '/dashboard/postbox/inbox',
	marketing: '/dashboard/campaigns',
};

const ownsPath = (prefix: string, path: string) => path === prefix || path.startsWith(`${prefix}/`);

/**
 * The context that owns a route, or null for shared routes (Dashboard,
 * Assistant, Knowledge, Settings…). Accepts full paths — query/hash are
 * ignored.
 */
export function contextForPath(fullPath: string): SidebarContext | null {
	const path = fullPath.split(/[?#]/, 1)[0] ?? fullPath;
	for (const context of SIDEBAR_CONTEXTS) {
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
	if (hrefs.includes(preferred)) return preferred;
	return hrefs[0] ?? '/dashboard';
}
