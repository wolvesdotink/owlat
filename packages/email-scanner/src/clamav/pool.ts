/**
 * ClamAV Connection Pool
 *
 * Maintains a pool of reusable connections to clamd for efficient scanning.
 * Since clamd's INSTREAM protocol is one-shot (connection closes after scan),
 * this pool manages connection creation and health checking rather than
 * traditional connection reuse.
 *
 * The pool provides:
 * - Concurrency limiting (prevent overwhelming clamd)
 * - Health checking via PING
 * - Graceful degradation when clamd is unavailable
 */

import type { ClamScanResult, ClamClientOptions } from '../types.js';
import { scanBufferDirect, ping } from './client.js';

type LogFn = NonNullable<ClamClientOptions['logger']>;

const defaultLogger: LogFn = (level, message, meta) => {
	// eslint-disable-next-line no-console
	if (level === 'error') console.error(`[clamav-pool] ${message}`, meta ?? '');
	// eslint-disable-next-line no-console
	else if (level === 'warn') console.warn(`[clamav-pool] ${message}`, meta ?? '');
	// eslint-disable-next-line no-console
	else console.log(`[clamav-pool] ${message}`, meta ?? '');
};

interface PoolOptions {
	host: string;
	port: number;
	connectTimeout: number;
	scanTimeout: number;
	maxConcurrency: number;
	failOpen: boolean;
	healthCheckInterval: number;
	logger: LogFn;
}

export class ClamPool {
	private readonly options: PoolOptions;
	private activeScanCount = 0;
	private pendingQueue: Array<{
		resolve: (result: ClamScanResult) => void;
		data: Buffer;
	}> = [];
	private healthy = true;
	private healthCheckTimer: ReturnType<typeof setInterval> | null = null;

	constructor(opts?: Partial<ClamClientOptions> & { healthCheckInterval?: number }) {
		this.options = {
			host: opts?.host ?? 'localhost',
			port: opts?.port ?? 3310,
			connectTimeout: opts?.connectTimeout ?? 5000,
			scanTimeout: opts?.scanTimeout ?? 30000,
			maxConcurrency: opts?.poolSize ?? 3,
			failOpen: opts?.failOpen ?? true,
			healthCheckInterval: opts?.healthCheckInterval ?? 60000,
			logger: opts?.logger ?? defaultLogger,
		};
	}

	/**
	 * Start periodic health checks.
	 */
	start(): void {
		if (this.healthCheckTimer) return;

		// Run initial health check
		void this.checkHealth();

		this.healthCheckTimer = setInterval(() => {
			void this.checkHealth();
		}, this.options.healthCheckInterval);
	}

	/**
	 * Stop health checks and drain pending scans.
	 */
	stop(): void {
		if (this.healthCheckTimer) {
			clearInterval(this.healthCheckTimer);
			this.healthCheckTimer = null;
		}

		// Resolve all pending scans as skipped
		while (this.pendingQueue.length > 0) {
			const pending = this.pendingQueue.shift()!;
			pending.resolve({ clean: true, skipped: true, error: 'Pool shutting down' });
		}
	}

	/**
	 * Check if clamd is healthy via PING.
	 */
	private async checkHealth(): Promise<void> {
		const wasHealthy = this.healthy;

		try {
			this.healthy = await ping(this.options.host, this.options.port, this.options.connectTimeout);

			if (!wasHealthy && this.healthy) {
				this.options.logger('info', 'ClamAV connection restored', {
					host: this.options.host,
					port: this.options.port,
				});
				// Process any pending scans
				this.processQueue();
			} else if (wasHealthy && !this.healthy) {
				this.options.logger('warn', 'ClamAV health check failed — scans will be skipped', {
					host: this.options.host,
					port: this.options.port,
				});
			}
		} catch {
			this.healthy = false;
		}
	}

	/**
	 * Scan a buffer for malware.
	 * Respects concurrency limits and health status.
	 */
	async scan(data: Buffer): Promise<ClamScanResult> {
		// If unhealthy, fail immediately according to failOpen policy
		if (!this.healthy) {
			if (this.options.failOpen) {
				return { clean: true, skipped: true, error: 'ClamAV unavailable' };
			}
			return { clean: false, error: 'ClamAV unavailable' };
		}

		// If at concurrency limit, queue the scan
		if (this.activeScanCount >= this.options.maxConcurrency) {
			return new Promise<ClamScanResult>((resolve) => {
				this.pendingQueue.push({ resolve, data });
			});
		}

		return this.executeScan(data);
	}

	/**
	 * Execute a scan, managing concurrency count.
	 */
	private async executeScan(data: Buffer): Promise<ClamScanResult> {
		this.activeScanCount++;

		try {
			const result = await scanBufferDirect(data, {
				host: this.options.host,
				port: this.options.port,
				connectTimeout: this.options.connectTimeout,
				scanTimeout: this.options.scanTimeout,
				failOpen: this.options.failOpen,
				logger: this.options.logger,
			});

			return result;
		} finally {
			this.activeScanCount--;
			this.processQueue();
		}
	}

	/**
	 * Process the next pending scan in the queue.
	 */
	private processQueue(): void {
		while (this.pendingQueue.length > 0 && this.activeScanCount < this.options.maxConcurrency) {
			const next = this.pendingQueue.shift()!;

			if (!this.healthy) {
				// Resolve immediately if unhealthy
				const result: ClamScanResult = this.options.failOpen
					? { clean: true, skipped: true, error: 'ClamAV unavailable' }
					: { clean: false, error: 'ClamAV unavailable' };
				next.resolve(result);
				continue;
			}

			// Execute asynchronously
			void this.executeScan(next.data).then(next.resolve);
		}
	}

	/**
	 * Get pool status for monitoring.
	 */
	getStatus(): { healthy: boolean; activeScanCount: number; pendingCount: number } {
		return {
			healthy: this.healthy,
			activeScanCount: this.activeScanCount,
			pendingCount: this.pendingQueue.length,
		};
	}

	/**
	 * Whether clamd is currently healthy.
	 */
	isHealthy(): boolean {
		return this.healthy;
	}
}
