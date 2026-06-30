/**
 * ClamAV TCP Client
 *
 * Pure TCP client for the clamd INSTREAM protocol.
 * Uses Node.js `net` module — only importable from Node.js environments (MTA),
 * NOT from Convex actions.
 *
 * Protocol (INSTREAM):
 * 1. Send: zINSTREAM\0
 * 2. Send: [4-byte big-endian length][chunk data] (repeat for all chunks)
 * 3. Send: [4-byte zero length] (terminator)
 * 4. Receive: "stream: OK\0" or "stream: <virus_name> FOUND\0"
 */

import { Socket } from 'net';
import type { ClamScanResult, ClamClientOptions } from '../types.js';

const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = 3310;
const DEFAULT_CONNECT_TIMEOUT = 5000;
const DEFAULT_SCAN_TIMEOUT = 30000;
const DEFAULT_CHUNK_SIZE = 8192;

type LogFn = NonNullable<ClamClientOptions['logger']>;

const defaultLogger: LogFn = (level, message, meta) => {
	// eslint-disable-next-line no-console
	if (level === 'error') console.error(`[clamav] ${message}`, meta ?? '');
	// eslint-disable-next-line no-console
	else if (level === 'warn') console.warn(`[clamav] ${message}`, meta ?? '');
	// eslint-disable-next-line no-console
	else console.log(`[clamav] ${message}`, meta ?? '');
};

/**
 * Create a TCP connection to clamd.
 */
function createConnection(
	host: string,
	port: number,
	connectTimeout: number,
): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = new Socket();
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error(`ClamAV connection timeout after ${connectTimeout}ms`));
		}, connectTimeout);

		socket.connect(port, host, () => {
			clearTimeout(timer);
			resolve(socket);
		});

		socket.on('error', (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

/**
 * Send INSTREAM command and stream data to clamd, then read the verdict.
 */
function instreamScan(
	socket: Socket,
	data: Buffer,
	scanTimeout: number,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error(`ClamAV scan timeout after ${scanTimeout}ms`));
		}, scanTimeout);

		const chunks: Buffer[] = [];

		socket.on('data', (chunk: Buffer) => {
			chunks.push(chunk);
		});

		socket.on('end', () => {
			clearTimeout(timer);
			const response = Buffer.concat(chunks).toString('utf-8').trim();
			resolve(response);
		});

		socket.on('error', (err) => {
			clearTimeout(timer);
			reject(err);
		});

		// Send INSTREAM command
		socket.write('zINSTREAM\0');

		// Stream data in chunks
		let offset = 0;
		while (offset < data.length) {
			const chunkSize = Math.min(DEFAULT_CHUNK_SIZE, data.length - offset);
			const chunk = data.subarray(offset, offset + chunkSize);

			// Write 4-byte big-endian length prefix
			const lengthBuf = Buffer.alloc(4);
			lengthBuf.writeUInt32BE(chunkSize, 0);
			socket.write(lengthBuf);

			// Write chunk data
			socket.write(chunk);

			offset += chunkSize;
		}

		// Send terminating zero-length chunk
		const terminator = Buffer.alloc(4);
		terminator.writeUInt32BE(0, 0);
		socket.write(terminator);

		// Let clamd close the connection after sending the response
	});
}

/**
 * Parse clamd response into a scan result.
 *
 * Expected formats:
 * - "stream: OK" — clean
 * - "stream: Eicar-Signature FOUND" — virus detected
 * - "stream: <error message> ERROR" — scan error
 */
export function parseResponse(response: string): ClamScanResult {
	// Remove null bytes (clamd's INSTREAM terminator)
	// eslint-disable-next-line no-control-regex
	const cleaned = response.replace(/\0/g, '').trim();

	if (cleaned.endsWith('OK')) {
		return { clean: true };
	}

	if (cleaned.includes('FOUND')) {
		// Extract virus name: "stream: VirusName FOUND"
		const match = /stream:\s*(.+?)\s+FOUND/.exec(cleaned);
		const virus = match?.[1] ?? 'unknown';
		return { clean: false, virus };
	}

	if (cleaned.includes('ERROR')) {
		const match = /stream:\s*(.+?)\s+ERROR/.exec(cleaned);
		const errorMsg = match?.[1] ?? cleaned;
		return { clean: true, error: `ClamAV error: ${errorMsg}`, skipped: true };
	}

	// Unknown response — fail open
	return { clean: true, error: `Unknown ClamAV response: ${cleaned}`, skipped: true };
}

/**
 * Scan a buffer using clamd's INSTREAM protocol.
 *
 * @param data - The file content to scan
 * @param options - Connection options
 * @returns Scan result
 */
export async function scanBufferDirect(
	data: Buffer,
	options?: Partial<ClamClientOptions>,
): Promise<ClamScanResult> {
	const host = options?.host ?? DEFAULT_HOST;
	const port = options?.port ?? DEFAULT_PORT;
	const connectTimeout = options?.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT;
	const scanTimeout = options?.scanTimeout ?? DEFAULT_SCAN_TIMEOUT;
	const failOpen = options?.failOpen ?? true;
	const log = options?.logger ?? defaultLogger;

	let socket: Socket | null = null;

	try {
		socket = await createConnection(host, port, connectTimeout);
		const response = await instreamScan(socket, data, scanTimeout);
		return parseResponse(response);
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		log('error', `ClamAV scan failed: ${errorMessage}`, { host, port });

		if (failOpen) {
			log('warn', 'ClamAV unreachable — failing open (allowing content through)', { host, port });
			return { clean: true, skipped: true, error: errorMessage };
		}

		return { clean: false, error: errorMessage };
	} finally {
		if (socket && !socket.destroyed) {
			socket.destroy();
		}
	}
}

/**
 * Send a PING command to clamd to check connectivity.
 */
export async function ping(
	host: string = DEFAULT_HOST,
	port: number = DEFAULT_PORT,
	timeout: number = DEFAULT_CONNECT_TIMEOUT,
): Promise<boolean> {
	let socket: Socket | null = null;
	try {
		socket = await createConnection(host, port, timeout);

		const response = await new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => {
				socket?.destroy();
				reject(new Error('PING timeout'));
			}, timeout);

			const chunks: Buffer[] = [];

			socket!.on('data', (chunk: Buffer) => {
				chunks.push(chunk);
			});

			socket!.on('end', () => {
				clearTimeout(timer);
				resolve(Buffer.concat(chunks).toString('utf-8').trim());
			});

			socket!.on('error', (err) => {
				clearTimeout(timer);
				reject(err);
			});

			socket!.write('zPING\0');
		});

		// eslint-disable-next-line no-control-regex
		return response.replace(/\0/g, '').trim() === 'PONG';
	} catch {
		return false;
	} finally {
		if (socket && !socket.destroyed) {
			socket.destroy();
		}
	}
}
