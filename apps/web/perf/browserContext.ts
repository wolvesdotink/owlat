/**
 * The browser context every scenario run gets, pinned so the workload is the
 * same on every machine.
 *
 * The timezone matters more than it looks: `ChatMessageList` groups rows by
 * calendar day in the browser's timezone, so the same 500 synthetic messages
 * render 15 date groups in UTC and 14 in Pacific/Gambier, with different node
 * and scroll-frame counts.
 *
 * The wall clock is pinned too ({@link SCENARIO_NOW}): Postbox rows print
 * their age against the current time ("5m", "3h", a date past a week) and the
 * Team Inbox rows age their waiting and deadline chips against it, so an
 * unpinned clock would change their text, and with it the DOM counters, from
 * one run to the next. Only `Date` is pinned; timers and animation frames run
 * at real speed, which the streaming scenarios' cadence depends on.
 */
import type { Browser, BrowserContext, BrowserContextOptions } from '@playwright/test';

export const SCENARIO_CONTEXT = {
	viewport: { width: 1280, height: 800 },
	deviceScaleFactor: 1,
	colorScheme: 'light',
	reducedMotion: 'no-preference',
	timezoneId: 'UTC',
	locale: 'en-US',
} as const satisfies BrowserContextOptions;

/**
 * What `Date.now()` returns in every scenario page: 2026-09-15 12:00 UTC, after
 * every synthetic timestamp the workloads build.
 */
export const SCENARIO_NOW = Date.UTC(2026, 8, 15, 12, 0, 0);

/** A fresh context for one run, with {@link SCENARIO_CONTEXT}. */
export function newScenarioContext(browser: Pick<Browser, 'newContext'>): Promise<BrowserContext> {
	return browser.newContext({ ...SCENARIO_CONTEXT, viewport: { ...SCENARIO_CONTEXT.viewport } });
}

/** What the page reports it runs in; a run whose page disagrees with the context is refused. */
interface ResolvedEnvironment {
	timeZone: string;
	locale: string;
	/** `Date.now()` in the page. */
	now: number;
}

export function assertPinned(resolved: ResolvedEnvironment): void {
	if (
		resolved.timeZone !== SCENARIO_CONTEXT.timezoneId ||
		resolved.locale !== SCENARIO_CONTEXT.locale
	) {
		throw new Error(
			`the page runs in ${resolved.timeZone} / ${resolved.locale}, not the pinned ${SCENARIO_CONTEXT.timezoneId} / ${SCENARIO_CONTEXT.locale}`
		);
	}
	if (resolved.now !== SCENARIO_NOW) {
		throw new Error(
			`the page's clock reads ${new Date(resolved.now).toISOString()}, not the pinned ${new Date(SCENARIO_NOW).toISOString()}`
		);
	}
}
