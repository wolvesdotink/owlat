/**
 * Every scenario run gets a context with a pinned timezone and locale, because
 * the chat history's date groups (and with them its DOM and scroll counters)
 * depend on the browser's timezone.
 */
import type { Browser, BrowserContextOptions } from '@playwright/test';
import { describe, expect, it } from 'vitest';
import { assertPinned, newScenarioContext, SCENARIO_CONTEXT } from '../browserContext';
import { SCENARIOS } from '../scenarios';
import { chatHistoryWorkload } from '../workload';

describe('scenario browser context', () => {
	it('the context the runner opens pins timezone, locale, viewport and scale', async () => {
		let options: BrowserContextOptions | undefined;
		const browser = {
			newContext: async (o?: BrowserContextOptions) => {
				options = o;
				return {} as Awaited<ReturnType<Browser['newContext']>>;
			},
		};
		await newScenarioContext(browser);
		expect(options).toMatchObject({
			timezoneId: 'UTC',
			locale: 'en-US',
			viewport: { width: 1280, height: 800 },
			deviceScaleFactor: 1,
			colorScheme: 'light',
			reducedMotion: 'no-preference',
		});
	});

	it('refuses a page that does not run in the pinned timezone and locale', () => {
		expect(() => assertPinned({ timeZone: 'UTC', locale: 'en-US' })).not.toThrow();
		expect(() => assertPinned({ timeZone: 'Pacific/Gambier', locale: 'en-US' })).toThrow(
			/Pacific\/Gambier/
		);
		expect(() => assertPinned({ timeZone: 'UTC', locale: 'de-DE' })).toThrow(/de-DE/);
	});

	it('the chat history renders the same date groups only because the timezone is pinned', () => {
		const scenario = SCENARIOS.find((s) => s.family === 'chat-history');
		if (scenario?.family !== 'chat-history') throw new Error('no chat-history scenario');
		const rows = chatHistoryWorkload(scenario);
		// ChatMessageList's own grouping: one group per formatted calendar day.
		const groups = (timeZone: string) => {
			const format = new Intl.DateTimeFormat('en', {
				weekday: 'long',
				year: 'numeric',
				month: 'long',
				day: 'numeric',
				timeZone,
			});
			return new Set(rows.map((r) => format.format(new Date(r.createdAt)))).size;
		};
		expect(groups(SCENARIO_CONTEXT.timezoneId)).toBe(15);
		expect(groups('Pacific/Gambier')).toBe(14);
	});
});
