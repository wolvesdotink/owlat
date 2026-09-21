import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { errorMessage } from '@owlat/shared';
import { hasVersionDrift, parseConfiguredVersionFromEnv } from '@owlat/shared/containerHealth';
import { applyEnvUpdates, isRateLimited, isValidIPv4 } from './security.js';
import { composePsServices, exec, json, OWLAT_DIR, readBody, requireAuth } from './http.js';
import { composeArgv, scheduleUpdaterRecreateSafely, servicesToRecreate } from './rollout.js';
import { handleUpdate } from './update.js';
import { handleApplyProfiles } from './applyProfiles.js';
import { critical } from './lifecycle.js';
import { handlePortChecks } from './portChecks.js';
import { handleProfileState } from './profileState.js';

const PORT = parseInt(process.env['PORT'] || '3200', 10);

// ── Endpoint handlers ──

// ── Helpers ──

/** Rewrite a `.env` file's content line-by-line (preserves comments + ordering). */
function rewriteEnvLines(content: string, transform: (line: string) => string): string {
	return content.split('\n').map(transform).join('\n');
}

function handleHealth(req: IncomingMessage, res: ServerResponse) {
	// Require authentication on health endpoint to prevent container enumeration
	if (!requireAuth(req, res)) return;

	// Rate limit: max 20 health checks per minute
	if (isRateLimited('health', 20, 60_000)) {
		return json(res, 429, { error: 'Too many health check requests.' });
	}

	// Get running container info
	const { containers, raw } = composePsServices();

	// `version` below is this container's baked-in OWLAT_VERSION: compose
	// interpolated it when the updater container was CREATED, so it reports what
	// is RUNNING. The CONFIGURED version lives in `.env` and is read here, per
	// request, because the two diverge exactly when nobody recreated the
	// containers — and without both values in the payload no caller can tell.
	let configuredVersion: string | undefined;
	try {
		configuredVersion = parseConfiguredVersionFromEnv(
			readFileSync(join(OWLAT_DIR, '.env'), 'utf-8')
		);
	} catch {
		// An unreadable .env is reported by the other endpoints; /health must
		// still answer with the container facts it does have.
	}

	json(res, 200, {
		status: 'ok',
		timestamp: Date.now(),
		version: process.env['OWLAT_VERSION'] || 'dev',
		configuredVersion: configuredVersion ?? null,
		versionDrift: configuredVersion ? hasVersionDrift(containers, configuredVersion) : null,
		gitSha: process.env['OWLAT_GIT_SHA'] || 'unknown',
		buildDate: process.env['OWLAT_BUILD_DATE'] || 'unknown',
		containers: containers.length > 0 ? containers : raw,
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
		const addIp = exec('ip', ['addr', 'add', `${ip}/32`, 'dev', 'eth0'], '/');
		steps.push({ step: 'ip-addr-add', ...addIp });

		// Step 2: Write persistent network config (survives reboots)
		try {
			await mkdir(INTERFACES_DIR, { recursive: true });
			await writeFile(
				persistFile,
				`auto eth0\niface eth0 inet static\n    address ${ip}/32\n`,
				'utf-8'
			);
			steps.push({ step: 'persist-config', stdout: `Wrote ${persistFile}`, stderr: '' });
		} catch (err) {
			steps.push({ step: 'persist-config', stdout: '', stderr: errorMessage(err) });
		}

		// Step 3: Append IP to IP_POOLS_CAMPAIGN in .env
		try {
			const envContent = await readFile(envFile, 'utf-8');
			const updated = rewriteEnvLines(envContent, (line) => {
				if (line.startsWith('IP_POOLS_CAMPAIGN=')) {
					const current = line.split('=')[1] || '';
					const ips = current.split(',').filter(Boolean);
					if (!ips.includes(ip)) ips.push(ip);
					return `IP_POOLS_CAMPAIGN=${ips.join(',')}`;
				}
				return line;
			});
			await writeFile(envFile, updated, 'utf-8');
			steps.push({ step: 'update-env', stdout: `Added ${ip} to IP_POOLS_CAMPAIGN`, stderr: '' });
		} catch (err) {
			steps.push({ step: 'update-env', stdout: '', stderr: errorMessage(err) });
		}

		// Step 4: Restart MTA to pick up new IP pool
		const restart = exec('docker', ['compose', 'restart', 'mta'], OWLAT_DIR);
		steps.push({ step: 'restart-mta', ...restart });
	} else {
		// Remove action
		// Step 1: Remove IP from network interface
		const delIp = exec('ip', ['addr', 'del', `${ip}/32`, 'dev', 'eth0'], '/');
		steps.push({ step: 'ip-addr-del', ...delIp });

		// Step 2: Remove persistent config
		try {
			await rm(persistFile, { force: true });
			steps.push({ step: 'remove-persist-config', stdout: `Removed ${persistFile}`, stderr: '' });
		} catch (err) {
			steps.push({ step: 'remove-persist-config', stdout: '', stderr: errorMessage(err) });
		}

		// Step 3: Remove IP from IP_POOLS_CAMPAIGN in .env
		try {
			const envContent = await readFile(envFile, 'utf-8');
			const updated = rewriteEnvLines(envContent, (line) => {
				if (line.startsWith('IP_POOLS_CAMPAIGN=')) {
					const current = line.split('=')[1] || '';
					const ips = current.split(',').filter((i) => i && i !== ip);
					return `IP_POOLS_CAMPAIGN=${ips.join(',')}`;
				}
				return line;
			});
			await writeFile(envFile, updated, 'utf-8');
			steps.push({
				step: 'update-env',
				stdout: `Removed ${ip} from IP_POOLS_CAMPAIGN`,
				stderr: '',
			});
		} catch (err) {
			steps.push({ step: 'update-env', stdout: '', stderr: errorMessage(err) });
		}

		// Step 4: Restart MTA
		const restart = exec('docker', ['compose', 'restart', 'mta'], OWLAT_DIR);
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
	const fields = [
		'instanceSecret',
		'convexAdminKey',
		'mtaApiKey',
		'mtaWebhookSecret',
		'redisPassword',
	] as const;
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
		envContent = await readFile(envFile, 'utf-8');
	} catch (err) {
		return json(res, 500, { error: `Cannot read .env: ${errorMessage(err)}` });
	}

	// Map of env var → new value. This five-key allowlist is a security property
	// of the secret-rotation primitive — /apply-profiles has its own single-key
	// list; neither may grow the other's.
	const updates: Record<string, string> = {
		INSTANCE_SECRET: body.instanceSecret!,
		CONVEX_ADMIN_KEY: body.convexAdminKey!,
		MTA_API_KEY: body.mtaApiKey!,
		MTA_WEBHOOK_SECRET: body.mtaWebhookSecret!,
		REDIS_PASSWORD: body.redisPassword!,
	};

	// Hardened line-by-line rewrite — preserves comments + ordering; keys absent
	// from .env stay absent (rotation never introduces new lines).
	const rewrite = applyEnvUpdates(envContent, updates, Object.keys(updates));
	if (!rewrite.ok) {
		return json(res, 400, { error: rewrite.reason });
	}

	try {
		await writeFile(envFile, rewrite.content, 'utf-8');
	} catch (err) {
		return json(res, 500, { error: `Cannot write .env: ${errorMessage(err)}` });
	}

	// Force-recreate to pick up new env vars. `up -d` alone doesn't
	// rebuild containers whose env changed — we need --force-recreate. Naming
	// the services excludes the updater and the socket proxy: a force-recreate
	// of THOSE stops this very process (and its Docker transport) partway down
	// the list, leaving the rest of the stack on the old secret.
	const plan = servicesToRecreate();
	if (plan.error) {
		return json(res, 500, { error: 'Container recreate failed', stderr: plan.error });
	}

	const recreate = exec(
		'docker',
		[...composeArgv(), 'up', '-d', '--force-recreate', ...plan.services],
		OWLAT_DIR
	);

	if (recreate.stderr && /error/i.test(recreate.stderr)) {
		return json(res, 500, { error: 'Container recreate failed', stderr: recreate.stderr });
	}

	// The updater must come back on the rotated secret too — through a helper,
	// for the same reason it is excluded above.
	const selfUpdate = scheduleUpdaterRecreateSafely();

	json(res, 200, { success: true, step: 'rotate-env', selfUpdate });
}

/**
 * The HTTP routing listener, exported separately from the listening socket so
 * tests can mount it on an ephemeral server (index.ts owns the real listen).
 */
export function buildRequestListener() {
	return async (req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url || '/', `http://localhost:${PORT}`);

		// The four state-changing endpoints run as critical sections: each writes
		// host files and only then reconciles the running containers, so a
		// SIGTERM landing between those two halves is what leaves the host's
		// configuration and its running state describing different deployments.
		if (req.method === 'POST' && url.pathname === '/update') {
			await critical(() => handleUpdate(req, res));
		} else if (req.method === 'POST' && url.pathname === '/configure-ip') {
			await critical(() => handleConfigureIp(req, res));
		} else if (req.method === 'POST' && url.pathname === '/rotate-env') {
			await critical(() => handleRotateEnv(req, res));
		} else if (req.method === 'POST' && url.pathname === '/apply-profiles') {
			await critical(() => handleApplyProfiles(req, res));
		} else if (req.method === 'POST' && url.pathname === '/port-checks') {
			await handlePortChecks(req, res);
		} else if (req.method === 'GET' && url.pathname === '/profile-state') {
			handleProfileState(req, res);
		} else if (req.method === 'GET' && url.pathname === '/health') {
			handleHealth(req, res);
		} else {
			json(res, 404, { error: 'Not found' });
		}
	};
}

export { PORT };
