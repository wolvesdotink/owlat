/**
 * The browser context every scenario run gets, pinned so the workload is the
 * same on every machine.
 *
 * The timezone matters more than it looks: `ChatMessageList` groups rows by
 * calendar day in the browser's timezone, so the same 500 synthetic messages
 * render 15 date groups in UTC and 14 in Pacific/Gambier, with different node
 * and scroll-frame counts. The timestamps themselves are fixed absolute values
 * (perf/workload.ts) and no mounted component reads the current date, so the
 * clock needs no pinning; the timezone and locale do.
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

/** A fresh context for one run, with {@link SCENARIO_CONTEXT}. */
export function newScenarioContext(browser: Pick<Browser, 'newContext'>): Promise<BrowserContext> {
	return browser.newContext({ ...SCENARIO_CONTEXT, viewport: { ...SCENARIO_CONTEXT.viewport } });
}

/** What the page reports it runs in; a run whose page disagrees with the context is refused. */
interface ResolvedLocale {
	timeZone: string;
	locale: string;
}

export function assertPinned(resolved: ResolvedLocale): void {
	if (
		resolved.timeZone !== SCENARIO_CONTEXT.timezoneId ||
		resolved.locale !== SCENARIO_CONTEXT.locale
	) {
		throw new Error(
			`the page runs in ${resolved.timeZone} / ${resolved.locale}, not the pinned ${SCENARIO_CONTEXT.timezoneId} / ${SCENARIO_CONTEXT.locale}`
		);
	}
}
