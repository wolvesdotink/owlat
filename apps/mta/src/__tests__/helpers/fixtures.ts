/**
 * Test fixtures for common MTA types
 */
import type { EmailJob } from '../../types.js';
import type { MtaConfig } from '../../config.js';

export function createTestEmailJob(overrides?: Partial<EmailJob>): EmailJob {
	return {
		messageId: 'test-msg-001',
		to: 'recipient@example.com',
		from: 'sender@example.com',
		subject: 'Test Subject',
		html: '<p>Hello World</p>',
		ipPool: 'transactional',
		organizationId: 'org-123',
		dkimDomain: 'example.com',
		...overrides,
	};
}

export function createTestConfig(overrides?: Partial<MtaConfig>): MtaConfig {
	return {
		fblDedupProtocol: 'owned-v2',
		port: 3100,
		bouncePort: 2525,
		redisUrl: 'redis://localhost:6379',
		apiKey: 'test-api-key',
		ehloHostname: 'mta.test.local',
		ehloHostnames: {},
		returnPathDomain: 'bounces.test.local',
		convexSiteUrl: 'https://convex.test.local',
		webhookSecret: 'test-webhook-secret',
		ipPools: {
			transactional: ['10.0.0.1'],
			campaign: ['10.0.0.2'],
		},
		dkimKeys: {},
		workerConcurrency: 10,
		serverId: 'test-server-1',
		smtpPool: {
			maxPerHost: 3,
			idleTimeoutMs: 30000,
			maxAgeMs: 300000,
			maxMessagesPerConnection: 100,
		},
		orgLimits: {
			defaultDailyLimit: 50000,
			defaultHourlyLimit: 5000,
		},
		submissionPort: 587,
		submissionEnabled: false,
		contentScreeningEnabled: true,
		contentMaxSizeKb: 500,
		deliveryLogMaxLen: 100000,
		deliveryLogTtlHours: 72,
		webhookDlqMaxSize: 10000,
		smtpOutcomeJournalMaxSize: 10000,
		bounceMaxConnectionsPerIp: 10,
		bounceMaxClients: 200,
		bounceTarpitEnabled: false,
		bounceTarpitDelayMs: 5000,
		inboundSpfEnabled: false,
		rspamdRejectThreshold: 15,
		smtpPoolGlobalMaxPerHost: 10,
		...overrides,
	};
}
