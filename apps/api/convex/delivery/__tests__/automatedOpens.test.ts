import { describe, expect, it } from 'vitest';
import {
	PREFETCH_WINDOW_MS,
	automatedOpenReason,
	classifyOpenRequest,
	isAppleNetworkIp,
} from '../automatedOpens';

const THUNDERBIRD =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Thunderbird/128.3.0';
const APPLE_MAIL_DIRECT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
const GMAIL_PROXY =
	'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)';
const OUTLOOK_DESKTOP =
	'Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0.17928; Pro)';

describe('isAppleNetworkIp', () => {
	it('recognises Apple IPv4 space', () => {
		expect(isAppleNetworkIp('17.58.101.4')).toBe(true);
		expect(isAppleNetworkIp('::ffff:17.58.101.4')).toBe(true);
	});

	it('recognises Apple IPv6 allocations, with or without leading zeros', () => {
		expect(isAppleNetworkIp('2620:149:a44::1')).toBe(true);
		expect(isAppleNetworkIp('2620:0149:a44::1')).toBe(true);
		expect(isAppleNetworkIp('2A01:B740:0:1::5')).toBe(true);
	});

	it('does not match other networks or unparseable input', () => {
		expect(isAppleNetworkIp('170.58.101.4')).toBe(false);
		expect(isAppleNetworkIp('203.0.113.17')).toBe(false);
		expect(isAppleNetworkIp('2001:db8::17')).toBe(false);
		expect(isAppleNetworkIp('17.1.2')).toBe(false);
		expect(isAppleNetworkIp('17.1.2.300')).toBe(false);
		expect(isAppleNetworkIp('unknown')).toBe(false);
		expect(isAppleNetworkIp('')).toBe(false);
		expect(isAppleNetworkIp(null)).toBe(false);
	});
});

describe('classifyOpenRequest', () => {
	it("treats Apple MPP's bare User-Agent as the Apple proxy", () => {
		expect(classifyOpenRequest({ userAgent: 'Mozilla/5.0', clientIp: 'unknown' })).toBe(
			'apple_proxy'
		);
	});

	it('treats any fetch from Apple address space as the Apple proxy', () => {
		expect(classifyOpenRequest({ userAgent: APPLE_MAIL_DIRECT, clientIp: '17.1.2.3' })).toBe(
			'apple_proxy'
		);
	});

	it('treats a missing User-Agent as a scanner', () => {
		expect(classifyOpenRequest({ userAgent: null, clientIp: '203.0.113.5' })).toBe('scanner');
		expect(classifyOpenRequest({ userAgent: '   ', clientIp: '203.0.113.5' })).toBe('scanner');
	});

	it.each([
		'Mimecast-URL-Scanner/1.0',
		'Barracuda Sentinel (EE)',
		'Mozilla/5.0 (compatible; Proofpoint URL Defense)',
		'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
		'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
		'Mozilla/5.0 (compatible; link preview bot)',
		'python-requests/2.31.0',
		'curl/8.4.0',
		'Go-http-client/1.1',
		'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/120.0.0.0 Safari/537.36',
	])('treats %s as a scanner', (userAgent) => {
		expect(classifyOpenRequest({ userAgent, clientIp: '203.0.113.5' })).toBe('scanner');
	});

	it.each([THUNDERBIRD, APPLE_MAIL_DIRECT, GMAIL_PROXY, OUTLOOK_DESKTOP])(
		'treats %s from a non-Apple address as a mail client',
		(userAgent) => {
			expect(classifyOpenRequest({ userAgent, clientIp: '203.0.113.5' })).toBe('client');
		}
	);

	it('does not read a device name that contains "bot" as a bot', () => {
		const cubotPhone =
			'Mozilla/5.0 (Linux; Android 11; CUBOT X50) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
		expect(classifyOpenRequest({ userAgent: cubotPhone, clientIp: '203.0.113.5' })).toBe('client');
	});
});

describe('automatedOpenReason', () => {
	const SENT_AT = 1_000_000;

	it('maps the proxy and scanner classes to their reasons', () => {
		const at = SENT_AT + 60_000;
		expect(automatedOpenReason({ agent: 'apple_proxy', at, sentAt: SENT_AT })).toBe('apple_mpp');
		expect(automatedOpenReason({ agent: 'scanner', at, sentAt: SENT_AT })).toBe('scanner');
	});

	it('counts a client fetch inside the prefetch window as automated', () => {
		expect(automatedOpenReason({ agent: 'client', at: SENT_AT + 1_000, sentAt: SENT_AT })).toBe(
			'prefetch'
		);
		expect(
			automatedOpenReason({
				agent: 'client',
				at: SENT_AT + PREFETCH_WINDOW_MS - 1,
				sentAt: SENT_AT,
			})
		).toBe('prefetch');
	});

	it('counts a client fetch after the window as a reader open', () => {
		expect(
			automatedOpenReason({
				agent: 'client',
				at: SENT_AT + PREFETCH_WINDOW_MS,
				sentAt: SENT_AT,
			})
		).toBeNull();
		expect(automatedOpenReason({ agent: 'client', at: SENT_AT, sentAt: undefined })).toBeNull();
		expect(automatedOpenReason({ agent: 'client', at: SENT_AT - 10, sentAt: SENT_AT })).toBeNull();
	});

	it('leaves provider-reported opens (no agent) counted as opens', () => {
		expect(automatedOpenReason({ agent: undefined, at: SENT_AT + 1, sentAt: SENT_AT })).toBeNull();
	});
});
