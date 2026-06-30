/**
 * Antivirus provider abstraction.
 *
 * ClamAV is the default; swapping to a different daemon (Sophos, custom
 * remote scanner) or a no-op for local dev is one adapter away. The
 * existing ClamClient interface stays in place — the AntivirusProvider
 * is a slightly narrower facade over it.
 */

import type { ClamScanResult, ClamClientOptions } from '../types.js';
import { createClamClient, type ClamClient } from './index.js';

export type AntivirusProviderType = 'clamav' | 'noop';

/**
 * Antivirus provider interface — what business logic needs from any AV
 * backend. `scan` returns a ClamScanResult-shaped object so the existing
 * MTA scan endpoint can consume the result unchanged.
 */
export interface AntivirusProvider {
	getProviderName(): AntivirusProviderType;
	scan(data: Buffer): Promise<ClamScanResult>;
	ping(): Promise<boolean>;
}

export function createClamAvProvider(options?: ClamClientOptions): AntivirusProvider {
	const client: ClamClient = createClamClient(options);
	client.start();
	return {
		getProviderName: () => 'clamav',
		scan: (data) => client.scan(data),
		ping: () => client.ping(),
	};
}

/**
 * Fail-open no-op: every scan returns clean=true with skipped=true. Useful
 * for local development and tests where running ClamAV is impractical.
 */
export function createNoopAntivirusProvider(): AntivirusProvider {
	return {
		getProviderName: () => 'noop',
		async scan() {
			return { clean: true, skipped: true };
		},
		async ping() {
			return true;
		},
	};
}

let cached: AntivirusProvider | null = null;
let cachedType: AntivirusProviderType | null = null;

/**
 * Reads ANTIVIRUS_PROVIDER (defaults to 'clamav' in production, 'noop'
 * when explicitly requested) and returns the cached adapter.
 */
export function getAntivirusProvider(options?: ClamClientOptions): AntivirusProvider {
	const type = ((typeof process !== 'undefined' && process.env?.['ANTIVIRUS_PROVIDER']) ??
		'clamav') as AntivirusProviderType;

	if (cached && cachedType === type) return cached;

	switch (type) {
		case 'clamav':
			cached = createClamAvProvider(options);
			cachedType = 'clamav';
			break;
		case 'noop':
			cached = createNoopAntivirusProvider();
			cachedType = 'noop';
			break;
		default:
			throw new Error(`Unknown antivirus provider: ${type}. Supported: clamav, noop`);
	}
	return cached;
}

export function clearAntivirusProviderCache(): void {
	cached = null;
	cachedType = null;
}
