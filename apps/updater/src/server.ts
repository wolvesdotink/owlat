import type { IncomingMessage, ServerResponse } from 'node:http';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
	errorMessage,
	isRateLimited,
	isValidIPv4,
	safeCompare,
	validateComposeTemplate,
} from './security.js';

const PORT = parseInt(process.env['PORT'] || '3200', 10);
const INSTANCE_SECRET = process.env['INSTANCE_SECRET'];
const OWLAT_DIR = process.env['OWLAT_DIR'] || '/opt/owlat';
const COMPOSE_FILE = join(OWLAT_DIR, 'docker-compose.yml');

// ── Helpers ──

function json(res: ServerResponse, status: number, body: unknown) {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(body));
}

/** Rewrite a `.env` file's content line-by-line (preserves comments + ordering). */
function rewriteEnvLines(content: string, transform: (line: string) => string): string {
	return content.split('\n').map(transform).join('\n');
}

function readBody(req: IncomingMessage): Promise<string> {
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
function requireAuth(req: IncomingMessage, res: ServerResponse): boolean {
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

function exec(cmd: string, cwd: string): { ok: boolean; stdout: string; stderr: string } {
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

// ── Endpoint handlers ──

async function handleUpdate(req: IncomingMessage, res: ServerResponse) {
	if (!requireAuth(req, res)) return;

	// Rate limit: max 2 updates per minute
	if (isRateLimited('update', 2, 60_000)) {
		return json(res, 429, { error: 'Too many update requests. Try again later.' });
	}

	let composeTemplate: string | undefined;

	try {
		const raw = await readBody(req);
		if (raw) {
			const body = JSON.parse(raw);
			composeTemplate = body.composeTemplate;
		}
	} catch {
		// No body or invalid JSON — proceed without compose template update
	}

	const steps: { step: string; ok?: boolean; stdout: string; stderr: string }[] = [];

	// Step 1: Validate and STAGE the new compose file if provided. The live
	// docker-compose.yml is only replaced after pull + convex-deploy succeed —
	// previously it was overwritten first, so a failed update left a
	// half-applied breaking template behind that the next manual
	// `docker compose up` would silently complete.
	const STAGED_FILE = join(OWLAT_DIR, 'docker-compose.next.yml');
	let composeFileForUpdate = COMPOSE_FILE;
	if (composeTemplate) {
		const validation = validateComposeTemplate(composeTemplate);
		if (!validation.valid) {
			return json(res, 400, {
				error: 'Compose template validation failed',
				reason: validation.reason,
				steps,
			});
		}

		try {
			writeFileSync(STAGED_FILE, composeTemplate, 'utf-8');
			composeFileForUpdate = STAGED_FILE;
			steps.push({ step: 'stage-compose', stdout: 'New compose template staged', stderr: '' });
		} catch (err) {
			return json(res, 500, {
				error: 'Failed to stage compose file',
				details: errorMessage(err),
				steps,
			});
		}
	}
	const composeCmd = `docker compose -f ${composeFileForUpdate}`;
	const discardStaged = () => {
		if (composeTemplate && existsSync(STAGED_FILE)) {
			try {
				unlinkSync(STAGED_FILE);
			} catch {
				// best-effort cleanup
			}
		}
	};

	// Step 2: Pull latest images (against the staged template, so a pull
	// failure leaves the running stack and its compose file untouched).
	const pull = exec(`${composeCmd} pull`, OWLAT_DIR);
	steps.push({ step: 'pull', ...pull });

	if (!pull.ok) {
		discardStaged();
		return json(res, 500, { error: 'Docker pull failed — update aborted, nothing changed', steps });
	}

	// Step 3 (P2.4 / S5): deploy Convex functions BEFORE restarting app
	// containers. If the new schema is incompatible with the deploy, we
	// bail out here — the running Web/MTA containers keep serving the old
	// (still compatible) code rather than being restarted against a half-
	// deployed backend.
	//
	// This requires the existing convex container to still be running at
	// its previous version, so the one-shot deployer can reach it.
	const deploy = exec(`${composeCmd} --profile deploy run --rm convex-deploy`, OWLAT_DIR);
	steps.push({ step: 'convex-deploy', ...deploy });

	if (!deploy.ok) {
		discardStaged();
		return json(res, 500, {
			error: 'convex-deploy failed — update aborted, running stack untouched',
			steps,
		});
	}

	// Step 4: Promote the staged template now that pull + deploy succeeded.
	if (composeTemplate) {
		try {
			writeFileSync(COMPOSE_FILE, composeTemplate, 'utf-8');
			unlinkSync(STAGED_FILE);
			steps.push({ step: 'write-compose', stdout: 'Compose file updated', stderr: '' });
		} catch (err) {
			return json(res, 500, {
				error: 'Failed to promote compose file',
				details: errorMessage(err),
				steps,
			});
		}
	}

	// Step 5: Apply — recreate changed containers now that the schema is live.
	// Runs against the promoted docker-compose.yml (+ any override file and
	// COMPOSE_PROFILES from .env, so profile-gated feature services update too).
	const up = exec('docker compose up -d --remove-orphans', OWLAT_DIR);
	steps.push({ step: 'up', ...up });

	if (!up.ok) {
		return json(res, 500, { error: 'docker compose up failed', steps });
	}

	json(res, 200, { success: true, steps });
}

function handleHealth(req: IncomingMessage, res: ServerResponse) {
	// Require authentication on health endpoint to prevent container enumeration
	if (!requireAuth(req, res)) return;

	// Rate limit: max 20 health checks per minute
	if (isRateLimited('health', 20, 60_000)) {
		return json(res, 429, { error: 'Too many health check requests.' });
	}

	// Get running container info
	const result = exec(
		'docker compose ps --format json',
		OWLAT_DIR,
	);

	// Parse container list and try to extract per-service version from image tag
	let containers: Array<Record<string, unknown>> = [];
	try {
		// `docker compose ps --format json` emits one JSON object per line (not an array)
		containers = result.stdout
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.map((line) => {
				const row = JSON.parse(line) as Record<string, unknown>;
				// Extract version from image tag — e.g. "ghcr.io/wolvesdotink/web:0.2.1" → "0.2.1".
				// Org-agnostic: splits on ":" and takes the tag, so any allowed registry works.
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

	json(res, 200, {
		status: 'ok',
		timestamp: Date.now(),
		version: process.env['OWLAT_VERSION'] || 'dev',
		gitSha: process.env['OWLAT_GIT_SHA'] || 'unknown',
		buildDate: process.env['OWLAT_BUILD_DATE'] || 'unknown',
		containers: containers.length > 0 ? containers : result.stdout,
	});
}

async function handleConfigureIp(req: IncomingMessage, res: ServerResponse) {
	if (!requireAuth(req, res)) return;

	// Rate limit: max 5 IP config requests per minute
	if (isRateLimited('configure-ip', 5, 60_000)) {
		return json(res, 429, { error: 'Too many configure-ip requests.' });
	}

	let ip: string;
	let action: 'add' | 'remove';

	try {
		const raw = await readBody(req);
		const body = JSON.parse(raw);
		ip = body.ip;
		action = body.action;

		if (!ip || !action || !['add', 'remove'].includes(action)) {
			return json(res, 400, { error: 'Missing or invalid "ip" or "action" (add|remove)' });
		}

		// Strict IPv4 validation using Node's built-in net.isIPv4() + octet range check
		if (!isValidIPv4(ip)) {
			return json(res, 400, { error: 'Invalid IPv4 address' });
		}
	} catch {
		return json(res, 400, { error: 'Invalid JSON body' });
	}

	const steps: { step: string; stdout: string; stderr: string }[] = [];
	const envFile = join(OWLAT_DIR, '.env');
	const INTERFACES_DIR = '/etc/network/interfaces.d';
	const persistFile = join(INTERFACES_DIR, `60-floating-${ip.replace(/\./g, '-')}.cfg`);

	if (action === 'add') {
		// Step 1: Attach IP to network interface
		const addIp = exec(`ip addr add ${ip}/32 dev eth0`, '/');
		steps.push({ step: 'ip-addr-add', ...addIp });

		// Step 2: Write persistent network config (survives reboots)
		try {
			mkdirSync(INTERFACES_DIR, { recursive: true });
			writeFileSync(persistFile, `auto eth0\niface eth0 inet static\n    address ${ip}/32\n`, 'utf-8');
			steps.push({ step: 'persist-config', stdout: `Wrote ${persistFile}`, stderr: '' });
		} catch (err) {
			steps.push({ step: 'persist-config', stdout: '', stderr: errorMessage(err) });
		}

		// Step 3: Append IP to IP_POOLS_CAMPAIGN in .env
		try {
			const envContent = readFileSync(envFile, 'utf-8');
			const updated = rewriteEnvLines(envContent, (line) => {
				if (line.startsWith('IP_POOLS_CAMPAIGN=')) {
					const current = line.split('=')[1] || '';
					const ips = current.split(',').filter(Boolean);
					if (!ips.includes(ip)) ips.push(ip);
					return `IP_POOLS_CAMPAIGN=${ips.join(',')}`;
				}
				return line;
			});
			writeFileSync(envFile, updated, 'utf-8');
			steps.push({ step: 'update-env', stdout: `Added ${ip} to IP_POOLS_CAMPAIGN`, stderr: '' });
		} catch (err) {
			steps.push({ step: 'update-env', stdout: '', stderr: errorMessage(err) });
		}

		// Step 4: Restart MTA to pick up new IP pool
		const restart = exec('docker compose restart mta', OWLAT_DIR);
		steps.push({ step: 'restart-mta', ...restart });
	} else {
		// Remove action
		// Step 1: Remove IP from network interface
		const delIp = exec(`ip addr del ${ip}/32 dev eth0`, '/');
		steps.push({ step: 'ip-addr-del', ...delIp });

		// Step 2: Remove persistent config
		try {
			if (existsSync(persistFile)) {
				unlinkSync(persistFile);
			}
			steps.push({ step: 'remove-persist-config', stdout: `Removed ${persistFile}`, stderr: '' });
		} catch (err) {
			steps.push({ step: 'remove-persist-config', stdout: '', stderr: errorMessage(err) });
		}

		// Step 3: Remove IP from IP_POOLS_CAMPAIGN in .env
		try {
			const envContent = readFileSync(envFile, 'utf-8');
			const updated = rewriteEnvLines(envContent, (line) => {
				if (line.startsWith('IP_POOLS_CAMPAIGN=')) {
					const current = line.split('=')[1] || '';
					const ips = current.split(',').filter((i) => i && i !== ip);
					return `IP_POOLS_CAMPAIGN=${ips.join(',')}`;
				}
				return line;
			});
			writeFileSync(envFile, updated, 'utf-8');
			steps.push({ step: 'update-env', stdout: `Removed ${ip} from IP_POOLS_CAMPAIGN`, stderr: '' });
		} catch (err) {
			steps.push({ step: 'update-env', stdout: '', stderr: errorMessage(err) });
		}

		// Step 4: Restart MTA
		const restart = exec('docker compose restart mta', OWLAT_DIR);
		steps.push({ step: 'restart-mta', ...restart });
	}

	json(res, 200, { success: true, action, ip, steps });
}

/**
 * P3.3 handler: apply rotated secrets to /opt/owlat/.env and recreate
 * containers. Authenticated by the CURRENT (pre-rotation) instance
 * secret; after this handler succeeds the process will restart and
 * INSTANCE_SECRET will reload to the new value. Future requests must
 * use the new secret.
 */
async function handleRotateEnv(req: IncomingMessage, res: ServerResponse) {
	if (!requireAuth(req, res)) return;

	// Rate limit: at most 1 rotation per minute. Tighter than /update
	// because rotation has real risk of locking the VPS out of its own
	// control plane if bugs hit mid-flight.
	if (isRateLimited('rotate-env', 1, 60_000)) {
		return json(res, 429, { error: 'Rotation rate-limited; try again shortly' });
	}

	interface RotateBody {
		instanceSecret?: string;
		convexAdminKey?: string;
		mtaApiKey?: string;
		mtaWebhookSecret?: string;
		redisPassword?: string;
	}
	let body: RotateBody;
	try {
		body = JSON.parse(await readBody(req)) as RotateBody;
	} catch {
		return json(res, 400, { error: 'Invalid JSON body' });
	}

	// Require ALL fields — partial rotation is a footgun.
	const fields = ['instanceSecret', 'convexAdminKey', 'mtaApiKey', 'mtaWebhookSecret', 'redisPassword'] as const;
	for (const f of fields) {
		const val = body[f];
		if (typeof val !== 'string' || val.length < 16 || val.length > 256) {
			return json(res, 400, { error: `Missing/invalid field: ${f}` });
		}
		// Defence: reject values that could break .env format (CR/LF/NUL injection).
		// oxlint-disable-next-line no-control-regex -- intentional: the NUL byte is exactly what we reject
		if (/[\r\n\x00]/.test(val)) {
			return json(res, 400, { error: `Field contains illegal character: ${f}` });
		}
	}

	const envFile = join(OWLAT_DIR, '.env');
	let envContent: string;
	try {
		envContent = readFileSync(envFile, 'utf-8');
	} catch (err) {
		return json(res, 500, { error: `Cannot read .env: ${errorMessage(err)}` });
	}

	// Map of env var → new value.
	const updates: Record<string, string> = {
		INSTANCE_SECRET: body.instanceSecret!,
		CONVEX_ADMIN_KEY: body.convexAdminKey!,
		MTA_API_KEY: body.mtaApiKey!,
		MTA_WEBHOOK_SECRET: body.mtaWebhookSecret!,
		REDIS_PASSWORD: body.redisPassword!,
	};

	// Line-by-line rewrite — preserves comments + ordering.
	const updated = rewriteEnvLines(envContent, (line) => {
		for (const [key, value] of Object.entries(updates)) {
			if (line.startsWith(`${key}=`)) return `${key}=${value}`;
		}
		return line;
	});

	try {
		writeFileSync(envFile, updated, 'utf-8');
	} catch (err) {
		return json(res, 500, { error: `Cannot write .env: ${errorMessage(err)}` });
	}

	// Force-recreate to pick up new env vars. `up -d` alone doesn't
	// rebuild containers whose env changed — we need --force-recreate.
	const recreate = exec('docker compose up -d --force-recreate', OWLAT_DIR);

	if (recreate.stderr && /error/i.test(recreate.stderr)) {
		return json(res, 500, { error: 'Container recreate failed', stderr: recreate.stderr });
	}

	json(res, 200, { success: true, step: 'rotate-env' });
}

/**
 * The HTTP routing listener, exported separately from the listening socket so
 * tests can mount it on an ephemeral server (index.ts owns the real listen).
 */
export function buildRequestListener() {
	return async (req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url || '/', `http://localhost:${PORT}`);

		if (req.method === 'POST' && url.pathname === '/update') {
			await handleUpdate(req, res);
		} else if (req.method === 'POST' && url.pathname === '/configure-ip') {
			await handleConfigureIp(req, res);
		} else if (req.method === 'POST' && url.pathname === '/rotate-env') {
			await handleRotateEnv(req, res);
		} else if (req.method === 'GET' && url.pathname === '/health') {
			handleHealth(req, res);
		} else {
			json(res, 404, { error: 'Not found' });
		}
	};
}

export { PORT };
