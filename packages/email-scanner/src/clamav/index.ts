/**
 * ClamAV Integration — High-Level API
 *
 * Provides a `createClamClient()` factory that wraps the connection pool
 * and exposes a simple `scan(buffer)` interface.
 *
 * IMPORTANT: This module uses Node.js `net` module and is only importable
 * from Node.js environments (e.g., the MTA service). It CANNOT run in
 * Convex actions or browser environments.
 */

import type { ClamScanResult, ClamClientOptions } from '../types.js';
import { ClamPool } from './pool.js';
import { ping as clamPing } from './client.js';

export interface ClamClient {
	/** Scan a buffer for malware */
	scan(data: Buffer): Promise<ClamScanResult>;
	/** Check if ClamAV daemon is reachable */
	ping(): Promise<boolean>;
	/** Get pool status for monitoring */
	getStatus(): { healthy: boolean; activeScanCount: number; pendingCount: number };
	/** Start health checking */
	start(): void;
	/** Stop the client and drain pending scans */
	stop(): void;
}

/**
 * Create a ClamAV client with connection pooling and health checking.
 *
 * @param options - Client configuration options
 * @returns ClamClient instance
 *
 * @example
 * ```typescript
 * const clam = createClamClient({
 *   host: 'clamav',
 *   port: 3310,
 *   failOpen: true,
 * });
 *
 * clam.start(); // Begin health checks
 *
 * const result = await clam.scan(fileBuffer);
 * if (!result.clean) {
 *   console.log(`Virus detected: ${result.virus}`);
 * }
 *
 * clam.stop(); // On shutdown
 * ```
 */
export function createClamClient(options?: ClamClientOptions): ClamClient {
	const pool = new ClamPool(options);

	return {
		scan: (data: Buffer) => pool.scan(data),
		ping: () => clamPing(
			options?.host ?? 'localhost',
			options?.port ?? 3310,
			options?.connectTimeout ?? 5000,
		),
		getStatus: () => pool.getStatus(),
		start: () => pool.start(),
		stop: () => pool.stop(),
	};
}

// Re-export types and utilities
export { ClamPool } from './pool.js';
export { scanBufferDirect, parseResponse, ping } from './client.js';
