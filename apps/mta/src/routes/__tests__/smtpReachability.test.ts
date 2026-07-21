import { describe, expect, it, vi } from 'vitest';
import { probeSmtpReachability, type SmtpReachabilityDeps } from '../smtpReachability.js';

function deps(patch: Partial<SmtpReachabilityDeps> = {}): SmtpReachabilityDeps {
	let now = 1_000;
	return {
		resolveMx: vi.fn().mockResolvedValue([
			{ exchange: 'mx20.example.net', priority: 20 },
			{ exchange: 'mx10.example.net', priority: 10 },
		]),
		connect: vi.fn().mockResolvedValue(undefined),
		now: () => now++,
		...patch,
	};
}

describe('probeSmtpReachability', () => {
	it('connects to the highest-priority MX from every unique configured IP', async () => {
		const d = deps();
		const result = await probeSmtpReachability(['203.0.113.10', '203.0.113.11', '203.0.113.10'], d);

		expect(result.status).toBe('ok');
		expect(result.targetMx).toBe('mx10.example.net');
		expect(d.connect).toHaveBeenCalledTimes(2);
		expect(d.connect).toHaveBeenCalledWith({
			host: 'mx10.example.net',
			port: 25,
			localAddress: '203.0.113.10',
			timeoutMs: 5_000,
		});
		expect(result.ips.map((ip) => ip.status)).toEqual(['ok', 'ok']);
	});

	it('degrades the aggregate and classifies a blocked source-IP path', async () => {
		const connect = vi.fn(async ({ localAddress }: { localAddress: string }) => {
			if (localAddress.endsWith('.11')) {
				const err = new Error('timed out') as Error & { code?: string };
				err.code = 'ETIMEDOUT';
				throw err;
			}
		});
		const result = await probeSmtpReachability(['203.0.113.10', '203.0.113.11'], deps({ connect }));

		expect(result.status).toBe('degraded');
		expect(result.ips).toEqual([
			expect.objectContaining({ ip: '203.0.113.10', status: 'ok' }),
			expect.objectContaining({
				ip: '203.0.113.11',
				status: 'failed',
				reason: 'timeout',
			}),
		]);
	});

	it('reports every source IP failed when MX resolution fails', async () => {
		const result = await probeSmtpReachability(
			['203.0.113.10'],
			deps({ resolveMx: vi.fn().mockRejectedValue(new Error('SERVFAIL')) })
		);

		expect(result.status).toBe('degraded');
		expect(result.targetMx).toBeUndefined();
		expect(result.ips[0]).toMatchObject({
			ip: '203.0.113.10',
			status: 'failed',
			reason: 'connection_error',
		});
	});

	it.each([
		['ECONNREFUSED', 'connection_refused'],
		['EADDRNOTAVAIL', 'source_ip_unavailable'],
		['ENETUNREACH', 'network_unreachable'],
		['EAI_AGAIN', 'connection_error'],
	] as const)('maps %s to %s', async (code, reason) => {
		const err = new Error(code) as Error & { code?: string };
		err.code = code;
		const result = await probeSmtpReachability(
			['203.0.113.10'],
			deps({ connect: vi.fn().mockRejectedValue(err) })
		);

		expect(result.ips[0]?.reason).toBe(reason);
	});
});
