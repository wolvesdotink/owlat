import { describe, it, expect, vi, beforeEach } from 'vitest';
import { verifyFcrdns, runFcrdnsSelfCheck, type FcrdnsDeps } from '../fcrdns.js';
import { logger } from '../../monitoring/logger.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/**
 * Build a stub of the DNS deps from simple maps:
 *  - ptr:   ip → PTR names
 *  - fwd:   hostname → A records
 * Missing keys throw ENOTFOUND, matching Node's dns/promises behaviour.
 */
function makeDeps(
	ptr: Record<string, string[]>,
	fwd: Record<string, string[]>,
): FcrdnsDeps {
	const notFound = (target: string) => Object.assign(new Error(`ENOTFOUND ${target}`), { code: 'ENOTFOUND' });
	return {
		reverse: vi.fn(async (ip: string) => {
			if (!(ip in ptr)) throw notFound(ip);
			return ptr[ip]!;
		}),
		resolve4: vi.fn(async (hostname: string) => {
			if (!(hostname in fwd)) throw notFound(hostname);
			return fwd[hostname]!;
		}),
	};
}

describe('verifyFcrdns', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('ok when PTR forward-confirms to the IP and matches an expected EHLO name', async () => {
		const deps = makeDeps(
			{ '1.2.3.4': ['mail.example.com'] },
			{ 'mail.example.com': ['1.2.3.4'] },
		);
		const result = await verifyFcrdns('1.2.3.4', ['mail.example.com'], deps);
		expect(result.ok).toBe(true);
		expect(result.reason).toBeUndefined();
		expect(result.ptrNames).toEqual(['mail.example.com']);
	});

	it('normalizes a trailing dot and case in the PTR name', async () => {
		const deps = makeDeps(
			{ '1.2.3.4': ['Mail.Example.COM.'] },
			{ 'mail.example.com': ['1.2.3.4'] },
		);
		const result = await verifyFcrdns('1.2.3.4', ['mail.example.com'], deps);
		expect(result.ok).toBe(true);
	});

	it('not ok with reason no-ptr when the IP has no PTR record', async () => {
		const deps = makeDeps({}, {});
		const result = await verifyFcrdns('1.2.3.4', ['mail.example.com'], deps);
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('no-ptr');
	});

	it('not ok with reason forward-mismatch when PTR forward-resolves to a different IP', async () => {
		const deps = makeDeps(
			{ '1.2.3.4': ['mail.example.com'] },
			{ 'mail.example.com': ['9.9.9.9'] },
		);
		const result = await verifyFcrdns('1.2.3.4', ['mail.example.com'], deps);
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('forward-mismatch');
	});

	it('not ok with reason ehlo-mismatch when PTR confirms but name differs from EHLO', async () => {
		const deps = makeDeps(
			{ '1.2.3.4': ['other.example.com'] },
			{ 'other.example.com': ['1.2.3.4'] },
		);
		const result = await verifyFcrdns('1.2.3.4', ['mail.example.com'], deps);
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('ehlo-mismatch');
	});

	it('not ok with reason lookup-error on a transient DNS failure', async () => {
		const deps: FcrdnsDeps = {
			reverse: vi.fn(async () => {
				throw Object.assign(new Error('SERVFAIL'), { code: 'ESERVFAIL' });
			}),
			resolve4: vi.fn(),
		};
		const result = await verifyFcrdns('1.2.3.4', ['mail.example.com'], deps);
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('lookup-error');
	});
});

describe('runFcrdnsSelfCheck', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	const config = {
		ipPools: { transactional: ['1.1.1.1', '2.2.2.2'], campaign: ['3.3.3.3'] },
		ehloHostname: 'fallback.example.com',
		ehloHostnames: {
			'1.1.1.1': 'mail1.example.com',
			'2.2.2.2': 'mail2.example.com',
		},
	};

	it('returns ok for every correctly-configured IP and logs no warnings', async () => {
		const deps = makeDeps(
			{
				'1.1.1.1': ['mail1.example.com'],
				'2.2.2.2': ['mail2.example.com'],
				'3.3.3.3': ['fallback.example.com'],
			},
			{
				'mail1.example.com': ['1.1.1.1'],
				'mail2.example.com': ['2.2.2.2'],
				'fallback.example.com': ['3.3.3.3'],
			},
		);
		const results = await runFcrdnsSelfCheck(config, deps);
		expect(results).toHaveLength(3);
		expect(results.every((r) => r.ok)).toBe(true);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('WARNs once per non-OK IP and still returns all results', async () => {
		const deps = makeDeps(
			{
				// 1.1.1.1 ok; 2.2.2.2 ehlo-mismatch; 3.3.3.3 no PTR
				'1.1.1.1': ['mail1.example.com'],
				'2.2.2.2': ['wrong.example.com'],
			},
			{
				'mail1.example.com': ['1.1.1.1'],
				'wrong.example.com': ['2.2.2.2'],
			},
		);
		const results = await runFcrdnsSelfCheck(config, deps);
		expect(results).toHaveLength(3);
		const byIp = Object.fromEntries(results.map((r) => [r.ip, r]));
		expect(byIp['1.1.1.1']!.ok).toBe(true);
		expect(byIp['2.2.2.2']!.reason).toBe('ehlo-mismatch');
		expect(byIp['3.3.3.3']!.reason).toBe('no-ptr');
		expect(logger.warn).toHaveBeenCalledTimes(2);
	});

	it('uses the fallback EHLO name for IPs not in the per-IP map', async () => {
		const deps = makeDeps(
			{ '3.3.3.3': ['fallback.example.com'] },
			{ 'fallback.example.com': ['3.3.3.3'] },
		);
		const result = await verifyFcrdns('3.3.3.3', ['fallback.example.com'], deps);
		expect(result.ok).toBe(true);
	});
});
