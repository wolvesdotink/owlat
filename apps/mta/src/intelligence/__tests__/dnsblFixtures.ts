import type { MtaConfig } from '../../config.js';

/** Minimal MTA config shared by the DNSBL fail-open suites. */
export function createDnsblTestConfig(overrides: Partial<MtaConfig> = {}): MtaConfig {
	return {
		port: 3100,
		bouncePort: 25,
		redisUrl: 'redis://localhost:6379',
		apiKey: 'test-key',
		ehloHostname: 'mail.owlat.com',
		ehloHostnames: {},
		returnPathDomain: 'bounces.owlat.com',
		convexSiteUrl: 'https://test.convex.site',
		webhookSecret: 'secret',
		ipPools: { transactional: ['10.0.0.1'], campaign: ['10.0.0.2'] },
		dkimKeys: {},
		workerConcurrency: 50,
		serverId: 'test-server',
		smtpPool: {
			maxPerHost: 3,
			idleTimeoutMs: 30000,
			maxAgeMs: 300000,
			maxMessagesPerConnection: 100,
		},
		orgLimits: { defaultDailyLimit: 50000, defaultHourlyLimit: 5000 },
		submissionPort: 587,
		submissionEnabled: false,
		contentScreeningEnabled: true,
		contentMaxSizeKb: 500,
		deliveryLogMaxLen: 100000,
		deliveryLogTtlHours: 72,
		webhookDlqMaxSize: 10000,
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

/** Deterministic lookup deps: no wall clock, no real timers, recorded delays. */
export function createRecordingLookupDeps(nowValues?: number[]) {
	const delays: number[] = [];
	let index = 0;
	return {
		delays,
		deps: {
			sleep: async (ms: number) => {
				delays.push(ms);
			},
			now: () => {
				if (!nowValues || nowValues.length === 0) return 0;
				const value = nowValues[Math.min(index, nowValues.length - 1)] ?? 0;
				index += 1;
				return value;
			},
		},
	};
}

export function dnsError(code: string): Error {
	return Object.assign(new Error(code), { code });
}
