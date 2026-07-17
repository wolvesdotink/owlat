import { describe, expect, it } from 'vitest';
import { isAllowedSlackWebhook } from '../notify';

describe('isAllowedSlackWebhook — SSRF allowlist', () => {
	it('accepts the Slack incoming-webhook host over https', () => {
		expect(isAllowedSlackWebhook('https://hooks.slack.com/services/T000/B000/xxxx')).toBe(true);
	});

	it('rejects non-https schemes', () => {
		expect(isAllowedSlackWebhook('http://hooks.slack.com/services/x')).toBe(false);
		expect(isAllowedSlackWebhook('ftp://hooks.slack.com/x')).toBe(false);
	});

	it('rejects non-Slack hosts', () => {
		expect(isAllowedSlackWebhook('https://evil.example.com/hook')).toBe(false);
		expect(isAllowedSlackWebhook('https://slack.com.evil.example/hook')).toBe(false);
		expect(isAllowedSlackWebhook('https://api.slack.com/hook')).toBe(false);
	});

	it('rejects internal / metadata addresses', () => {
		expect(isAllowedSlackWebhook('https://169.254.169.254/latest/meta-data')).toBe(false);
		expect(isAllowedSlackWebhook('https://127.0.0.1/hook')).toBe(false);
		expect(isAllowedSlackWebhook('https://localhost/hook')).toBe(false);
	});

	it('rejects credential-embedding (userinfo) URLs', () => {
		expect(isAllowedSlackWebhook('https://user:pass@hooks.slack.com/x')).toBe(false);
		expect(isAllowedSlackWebhook('https://hooks.slack.com@evil.example/x')).toBe(false);
	});

	it('rejects malformed URLs', () => {
		expect(isAllowedSlackWebhook('not a url')).toBe(false);
		expect(isAllowedSlackWebhook('')).toBe(false);
	});
});
