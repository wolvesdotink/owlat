/**
 * Shared plumbing for the updater's endpoint handlers: JSON responses, body
 * reading, instance-secret auth, docker exec and compose-ps parsing. Split out
 * of server.ts so each privileged endpoint module stays focused on its own
 * control flow (CONVENTIONS.md ~500 LOC rule).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { execSync } from 'node:child_process';
import { errorMessage, safeCompare } from './security.js';

const INSTANCE_SECRET = process.env['INSTANCE_SECRET'];
export const OWLAT_DIR = process.env['OWLAT_DIR'] || '/opt/owlat';

export function json(res: ServerResponse, status: number, body: unknown) {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(body));
}

export function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => chunks.push(chunk));
		req.on('end', () => resolve(Buffer.concat(chunks).toString()));
		req.on('error', reject);
	});
}

/**
 * Validate that the request has a valid instance secret.
 * Returns true if authorized, false otherwise (and sends 401 response).
 */
export function requireAuth(req: IncomingMessage, res: ServerResponse): boolean {
	if (!INSTANCE_SECRET) {
		json(res, 500, { error: 'INSTANCE_SECRET not configured' });
		return false;
	}

	const provided = req.headers['x-instance-secret'];
	if (typeof provided !== 'string' || !safeCompare(provided, INSTANCE_SECRET)) {
		json(res, 401, { error: 'Unauthorized' });
		return false;
	}

	return true;
}

export function exec(cmd: string, cwd: string): { ok: boolean; stdout: string; stderr: string } {
	try {
		const stdout = execSync(cmd, {
			cwd,
			timeout: 300_000, // 5 minutes
			encoding: 'utf-8',
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		return { ok: true, stdout: stdout || '', stderr: '' };
	} catch (err) {
		// Failure = non-zero exit (execSync throws), NOT a grep of stderr:
		// docker writes progress to stderr on success, and real failures
		// ('Error response from daemon') broke the old case-sensitive match.
		const e = err as { stdout?: string | Buffer | null; stderr?: string | Buffer | null };
		return {
			ok: false,
			stdout: e.stdout?.toString() || '',
			stderr: e.stderr?.toString() || errorMessage(err),
		};
	}
}

/**
 * Run `docker compose ps` and parse per-service rows (shared by /health and
 * /apply-profiles). Extracts each service's version from its image tag —
 * e.g. "ghcr.io/wolvesdotink/web:0.2.1" → "0.2.1". Org-agnostic: splits on
 * ":" and takes the tag, so any allowed registry works.
 */
export function composePsServices(): { containers: Array<Record<string, unknown>>; raw: string } {
	const result = exec('docker compose ps --format json', OWLAT_DIR);

	let containers: Array<Record<string, unknown>> = [];
	try {
		// `docker compose ps --format json` emits one JSON object per line (not an array)
		containers = result.stdout
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.map((line) => {
				const row = JSON.parse(line) as Record<string, unknown>;
				const image = typeof row['Image'] === 'string' ? row['Image'] : '';
				const tag = image.split(':').pop() || '';
				return {
					service: row['Service'],
					state: row['State'],
					status: row['Status'],
					image,
					imageTag: tag,
					health: row['Health'],
				};
			});
	} catch {
		// Fall back to raw stdout if parsing fails
	}

	return { containers, raw: result.stdout };
}
