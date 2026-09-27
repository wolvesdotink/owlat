import { describe, expect, it } from 'vitest';
import {
	CLICK_BURST_WINDOW_MS,
	automatedClickReason,
	classifyClickRequest,
} from '../automatedClicks';
import { PREFETCH_WINDOW_MS } from '../automatedOpens';

const CHROME_DESKTOP =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const SAFARI_IPHONE =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1';

describe('classifyClickRequest', () => {
	it.each([CHROME_DESKTOP, SAFARI_IPHONE])('treats a browser as a reader: %s', (userAgent) => {
		expect(classifyClickRequest({ userAgent })).toBe('client');
	});

	it.each([
		'Mimecast-URL-Scanner/1.0',
		'Proofpoint URL Defense',
		'Barracuda Sentinel (EE)',
		'python-requests/2.31.0',
		'curl/8.4.0',
		'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
	])('treats a scanner as automated: %s', (userAgent) => {
		expect(classifyClickRequest({ userAgent })).toBe('scanner');
	});

	it('treats a missing User-Agent as a scanner', () => {
		expect(classifyClickRequest({ userAgent: null })).toBe('scanner');
		expect(classifyClickRequest({ userAgent: '  ' })).toBe('scanner');
	});

	it('treats the bare Mozilla/5.0 User-Agent as a scanner, not a person', () => {
		expect(classifyClickRequest({ userAgent: 'Mozilla/5.0' })).toBe('scanner');
	});
});

describe('automatedClickReason', () => {
	const SENT_AT = 1_000_000;
	const URL_A = 'https://example.com/a';
	const URL_B = 'https://example.com/b';
	const base = {
		agent: 'client' as const,
		at: SENT_AT + 3_600_000,
		url: URL_A,
		sentAt: SENT_AT,
		previousClick: undefined,
	};

	it('keeps a provider-reported click (no agent) as a reader click', () => {
		expect(automatedClickReason({ ...base, agent: undefined, at: SENT_AT + 1 })).toBeNull();
	});

	it('flags a scanner', () => {
		expect(automatedClickReason({ ...base, agent: 'scanner' })).toBe('scanner');
	});

	it('flags a click inside the prefetch window after sending', () => {
		expect(automatedClickReason({ ...base, at: SENT_AT + PREFETCH_WINDOW_MS - 1 })).toBe(
			'prefetch'
		);
		expect(automatedClickReason({ ...base, at: SENT_AT + PREFETCH_WINDOW_MS })).toBeNull();
	});

	it('flags a second link followed within the burst window', () => {
		const previousClick = { url: URL_A, clickedAt: base.at - (CLICK_BURST_WINDOW_MS - 1) };
		expect(automatedClickReason({ ...base, url: URL_B, previousClick })).toBe('burst');
	});

	it('does not flag the same link clicked twice, or a second link clicked later', () => {
		const justNow = { url: URL_A, clickedAt: base.at - 200 };
		expect(automatedClickReason({ ...base, previousClick: justNow })).toBeNull();
		const earlier = { url: URL_A, clickedAt: base.at - CLICK_BURST_WINDOW_MS };
		expect(automatedClickReason({ ...base, url: URL_B, previousClick: earlier })).toBeNull();
	});

	it('does not apply the prefetch rule without a send time', () => {
		expect(automatedClickReason({ ...base, sentAt: undefined, at: 5 })).toBeNull();
	});
});
