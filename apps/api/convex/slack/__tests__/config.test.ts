import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	readSlackApprovalsConfig,
	SLACK_APPROVALS_DEFAULT_QUORUM,
	SLACK_APPROVALS_DEFAULT_TTL_MINUTES,
	SLACK_APPROVALS_MAX_QUORUM,
	SLACK_APPROVALS_MAX_TTL_MINUTES,
} from '../config';

afterEach(() => {
	vi.unstubAllEnvs();
});

function configure(overrides: Record<string, string | undefined> = {}) {
	const env: Record<string, string | undefined> = {
		SLACK_APPROVALS_SIGNING_SECRET: 'secret',
		SLACK_APPROVALS_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/x',
		...overrides,
	};
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) vi.stubEnv(key, '');
		else vi.stubEnv(key, value);
	}
}

describe('readSlackApprovalsConfig — activation requires both secrets', () => {
	it('is inactive when nothing is configured', () => {
		vi.unstubAllEnvs();
		vi.stubEnv('SLACK_APPROVALS_SIGNING_SECRET', '');
		vi.stubEnv('SLACK_APPROVALS_WEBHOOK_URL', '');
		expect(readSlackApprovalsConfig().active).toBe(false);
	});

	it('is inactive with only the signing secret', () => {
		configure({ SLACK_APPROVALS_WEBHOOK_URL: undefined });
		expect(readSlackApprovalsConfig().active).toBe(false);
	});

	it('is inactive with only the webhook url', () => {
		configure({ SLACK_APPROVALS_SIGNING_SECRET: undefined });
		expect(readSlackApprovalsConfig().active).toBe(false);
	});

	it('is active with both, using defaults', () => {
		configure();
		const config = readSlackApprovalsConfig();
		expect(config.active).toBe(true);
		if (!config.active) throw new Error('expected active');
		expect(config.quorum).toBe(SLACK_APPROVALS_DEFAULT_QUORUM);
		expect(config.ttlMs).toBe(SLACK_APPROVALS_DEFAULT_TTL_MINUTES * 60_000);
	});
});

describe('readSlackApprovalsConfig — quorum clamping (never weakens)', () => {
	it('honours a configured quorum', () => {
		configure({ SLACK_APPROVALS_QUORUM: '3' });
		const config = readSlackApprovalsConfig();
		expect(config.active && config.quorum).toBe(3);
	});

	it('clamps a huge quorum to the ceiling', () => {
		configure({ SLACK_APPROVALS_QUORUM: '100000' });
		const config = readSlackApprovalsConfig();
		expect(config.active && config.quorum).toBe(SLACK_APPROVALS_MAX_QUORUM);
	});

	it('falls back to default for invalid / zero quorum', () => {
		for (const bad of ['0', '-2', 'abc', '1.5']) {
			configure({ SLACK_APPROVALS_QUORUM: bad });
			const config = readSlackApprovalsConfig();
			expect(config.active && config.quorum).toBe(SLACK_APPROVALS_DEFAULT_QUORUM);
		}
	});
});

describe('readSlackApprovalsConfig — TTL clamping', () => {
	it('clamps an enormous TTL to the ceiling', () => {
		configure({ SLACK_APPROVALS_TTL_MINUTES: '9999999' });
		const config = readSlackApprovalsConfig();
		expect(config.active && config.ttlMs).toBe(SLACK_APPROVALS_MAX_TTL_MINUTES * 60_000);
	});

	it('falls back to default for invalid TTL', () => {
		configure({ SLACK_APPROVALS_TTL_MINUTES: 'soon' });
		const config = readSlackApprovalsConfig();
		expect(config.active && config.ttlMs).toBe(SLACK_APPROVALS_DEFAULT_TTL_MINUTES * 60_000);
	});
});
