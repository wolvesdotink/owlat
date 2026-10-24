/**
 * Every scenario run gets a context with a pinned timezone, locale and clock,
 * because the chat history's date groups depend on the browser's timezone and
 * the mail lists' relative times and waiting chips on the current time (and
 * with them the DOM and update counters).
 */
import type { Browser, BrowserContextOptions } from '@playwright/test';
import { describe, expect, it } from 'vitest';
import {
	assertPinned,
	newScenarioContext,
	SCENARIO_CONTEXT,
	SCENARIO_NOW,
} from '../browserContext';
import { postboxListWorkload, teamInboxWorkload } from '../listWorkload';
import { SCENARIOS } from '../scenarios';
import { assistantStreamWorkload, chatHistoryWorkload } from '../workload';

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

	it('refuses a page that does not run in the pinned timezone, locale and clock', () => {
		const pinned = { timeZone: 'UTC', locale: 'en-US', now: SCENARIO_NOW };
		expect(() => assertPinned(pinned)).not.toThrow();
		expect(() => assertPinned({ ...pinned, timeZone: 'Pacific/Gambier' })).toThrow(
			/Pacific\/Gambier/
		);
		expect(() => assertPinned({ ...pinned, locale: 'de-DE' })).toThrow(/de-DE/);
		expect(() => assertPinned({ ...pinned, now: SCENARIO_NOW + 1 })).toThrow(/clock/);
	});

	it('the pinned clock reads after every synthetic timestamp', () => {
		const latest = SCENARIOS.flatMap((scenario) => {
			switch (scenario.family) {
				case 'assistant-stream': {
					const { history } = assistantStreamWorkload(scenario);
					return history.map((row) => row.createdAt);
				}
				case 'chat-history':
					return chatHistoryWorkload(scenario).map((row) => row.createdAt);
				case 'postbox-list':
					return postboxListWorkload(scenario).map((row) => row.receivedAt);
				case 'team-inbox':
					return teamInboxWorkload(scenario).map((row) => row.lastMessageAt);
			}
		});
		expect(Math.max(...latest)).toBeLessThan(SCENARIO_NOW);
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
