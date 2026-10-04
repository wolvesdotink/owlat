import { describe, expect, it } from 'vitest';
import en from '../../../i18n/locales/en.json';
import { inboxRetryToast } from '../inboxRetry';

const lookup = (key: string): unknown =>
	key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], en);

describe('inboxRetryToast', () => {
	it('names the plan the server took', () => {
		expect(lookup(inboxRetryToast('sendAgain'))).toBe('Sending the approved reply again');
		expect(lookup(inboxRetryToast('review'))).toBe('The reply is back in review');
		expect(lookup(inboxRetryToast('redraft'))).toBe('The agent will try again');
	});

	it('stays neutral when a backend from before #1220 reports no plan', () => {
		expect(lookup(inboxRetryToast(undefined))).toBe('Retry started');
	});
});
