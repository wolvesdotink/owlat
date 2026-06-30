import { describe, it, expect, beforeEach } from 'vitest';
import {
	getUrlReputationProvider,
	clearUrlReputationProviderCache,
	createNoopUrlReputationProvider,
	type UrlReputationProvider,
} from '../urls/provider.js';
import {
	getAntivirusProvider,
	clearAntivirusProviderCache,
	createNoopAntivirusProvider,
	type AntivirusProvider,
} from '../clamav/provider.js';

beforeEach(() => {
	clearUrlReputationProviderCache();
	clearAntivirusProviderCache();
	delete (process.env as Record<string, string | undefined>).URL_REPUTATION_PROVIDER;
	delete (process.env as Record<string, string | undefined>).ANTIVIRUS_PROVIDER;
});

// =============================================================================
// UrlReputationProvider
// =============================================================================
describe('UrlReputationProvider — factory lifecycle (Bucket 1)', () => {
	it('defaults to safe-browsing when env is unset', () => {
		expect(getUrlReputationProvider().getProviderName()).toBe('safe-browsing');
	});

	it('switches to noop when env=noop', () => {
		(process.env as Record<string, string | undefined>).URL_REPUTATION_PROVIDER = 'noop';
		expect(getUrlReputationProvider().getProviderName()).toBe('noop');
	});

	it('caches by type', () => {
		const a = getUrlReputationProvider();
		const b = getUrlReputationProvider();
		expect(a).toBe(b);
	});

	it('throws on unknown provider name', () => {
		(process.env as Record<string, string | undefined>).URL_REPUTATION_PROVIDER = 'mystery';
		expect(() => getUrlReputationProvider()).toThrow(/Unknown URL reputation provider/);
	});
});

describe('UrlReputationProvider — contract (Bucket 2)', () => {
	it('every adapter exposes getProviderName + check', () => {
		const adapters: UrlReputationProvider[] = [
			createNoopUrlReputationProvider(),
			getUrlReputationProvider(),
		];
		for (const p of adapters) {
			expect(typeof p.getProviderName).toBe('function');
			expect(typeof p.check).toBe('function');
		}
	});
});

describe('UrlReputationProvider — behavior parity (Bucket 3)', () => {
	it('safe-browsing without api key returns all-safe (mirrors legacy guard)', async () => {
		const provider = getUrlReputationProvider();
		const results = await provider.check(['https://example.com', 'https://other.test']);
		expect(results.every((r) => r.verdict === 'safe')).toBe(true);
		expect(results.map((r) => r.url)).toEqual(['https://example.com', 'https://other.test']);
	});
});

describe('UrlReputationProvider — extension proof (Bucket 4)', () => {
	it('a test-double provider satisfies the interface', async () => {
		const seen: string[] = [];
		const mock: UrlReputationProvider = {
			getProviderName: () => 'safe-browsing',
			check: async (urls) => {
				seen.push(...urls);
				return urls.map((url) => ({ url, verdict: 'safe', source: 'mock' }));
			},
		};
		const out = await mock.check(['https://x']);
		expect(seen).toEqual(['https://x']);
		expect(out[0]?.source).toBe('mock');
	});
});

describe('UrlReputationProvider — failure modes (Bucket 5)', () => {
	it('noop adapter never throws and reports source=noop', async () => {
		const p = createNoopUrlReputationProvider();
		const out = await p.check(['https://x']);
		expect(out[0]).toEqual({ url: 'https://x', verdict: 'safe', source: 'noop' });
	});
});

// =============================================================================
// AntivirusProvider
// =============================================================================
describe('AntivirusProvider — factory lifecycle (Bucket 1)', () => {
	it('switches to noop when env=noop', () => {
		(process.env as Record<string, string | undefined>).ANTIVIRUS_PROVIDER = 'noop';
		expect(getAntivirusProvider().getProviderName()).toBe('noop');
	});

	it('throws on unknown provider name', () => {
		(process.env as Record<string, string | undefined>).ANTIVIRUS_PROVIDER = 'mystery';
		expect(() => getAntivirusProvider()).toThrow(/Unknown antivirus provider/);
	});

	it('clearAntivirusProviderCache forces a fresh instance', () => {
		(process.env as Record<string, string | undefined>).ANTIVIRUS_PROVIDER = 'noop';
		const a = getAntivirusProvider();
		clearAntivirusProviderCache();
		const b = getAntivirusProvider();
		expect(a).not.toBe(b);
	});
});

describe('AntivirusProvider — contract (Bucket 2)', () => {
	it('every adapter exposes getProviderName + scan + ping', () => {
		const adapters: AntivirusProvider[] = [createNoopAntivirusProvider()];
		for (const p of adapters) {
			expect(typeof p.getProviderName).toBe('function');
			expect(typeof p.scan).toBe('function');
			expect(typeof p.ping).toBe('function');
		}
	});
});

describe('AntivirusProvider — behavior parity (Bucket 3)', () => {
	it('noop adapter returns clean=true with skipped=true (fail-open semantics)', async () => {
		const p = createNoopAntivirusProvider();
		const result = await p.scan(Buffer.from('test'));
		expect(result).toEqual({ clean: true, skipped: true });
	});
});

describe('AntivirusProvider — extension proof (Bucket 4)', () => {
	it('a test-double provider satisfies the interface', async () => {
		const mock: AntivirusProvider = {
			getProviderName: () => 'clamav',
			scan: async () => ({ clean: false, virus: 'Eicar-Test' }),
			ping: async () => true,
		};
		const result = await mock.scan(Buffer.alloc(0));
		expect(result.clean).toBe(false);
		expect(result.virus).toBe('Eicar-Test');
	});
});

describe('AntivirusProvider — failure modes (Bucket 5)', () => {
	it('noop ping always returns true', async () => {
		expect(await createNoopAntivirusProvider().ping()).toBe(true);
	});
});
