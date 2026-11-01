/**
 * `owlat rollback` restores the snapshot the updater took before the last
 * in-app update, through the updater's own `GET /snapshot` and
 * `POST /rollback`. These cases run the REAL `scripts/owlat` against a stub
 * `docker` whose `compose exec -T updater …` runs the command on this machine,
 * so the request script the CLI hands the updater container is exercised for
 * real, against a local server standing in for the updater.
 */

import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { chmod, copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const run = promisify(execFile);
const SECRET = 'test-instance-secret-0123456789';
const SNAPSHOT_ID = 'snap-abc123-0123abcd';

// `compose exec -T updater <cmd…>` runs <cmd…> here; anything else is refused,
// so the CLI cannot reach Docker any other way.
const STUB_DOCKER = `#!/bin/sh
if [ "$1 $2 $3 $4" = "compose exec -T updater" ]; then
	shift 4
	exec "$@"
fi
echo "unexpected docker call: $*" >&2
exit 3
`;

/** What the updater serves the CLI. */
const ROUTES = new Set(['GET /snapshot', 'POST /rollback']);

interface Seen {
	method: string;
	path: string;
	secret: string | undefined;
	body: string;
}

let server: Server;
let port = 0;
let seen: Seen[] = [];
let answers: Record<string, { status: number; body: unknown }> = {};
let root = '';
let dir = '';
let stubDir = '';

beforeAll(async () => {
	server = createServer((req: IncomingMessage, res) => {
		// Only the updater's two routes are recorded. Anything else that finds
		// the port (a host process probing listening ports sends `GET /`) gets
		// a 404 and stays out of `seen`; a CLI calling a wrong route still
		// fails, by the route it never called.
		if (!ROUTES.has(`${req.method} ${req.url}`)) {
			res.writeHead(404).end();
			return;
		}
		let body = '';
		req.on('data', (chunk) => (body += chunk));
		req.on('end', () => {
			seen.push({
				method: req.method ?? '',
				path: req.url ?? '',
				secret: req.headers['x-instance-secret'] as string | undefined,
				body,
			});
			const answer = answers[`${req.method} ${req.url}`] ?? { status: 404, body: {} };
			res.writeHead(answer.status, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(answer.body));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (typeof address === 'object' && address) port = address.port;

	root = await realpath(await mkdtemp(join(tmpdir(), 'owlat-rollback-cli-')));
	dir = join(root, 'owlat');
	stubDir = join(root, 'stub-bin');
	await mkdir(join(dir, 'scripts'), { recursive: true });
	await mkdir(stubDir, { recursive: true });
	await copyFile(join(REPOSITORY_ROOT, 'scripts/owlat'), join(dir, 'scripts', 'owlat'));
	await writeFile(join(dir, 'docker-compose.yml'), 'services: {}\n');
	await writeFile(join(stubDir, 'docker'), STUB_DOCKER);
	await chmod(join(stubDir, 'docker'), 0o755);
});

afterAll(async () => {
	server.close();
	await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
	seen = [];
	answers = {
		'GET /snapshot': {
			status: 200,
			body: {
				snapshot: { id: SNAPSHOT_ID, state: 'kept' },
				description: `Snapshot ${SNAPSHOT_ID}, taken before the update from 0.4.16 to 0.4.17 (kept).`,
			},
		},
		'POST /rollback': {
			status: 200,
			body: {
				success: true,
				rollout: 'rolled-back',
				description: `Rolled back to snapshot ${SNAPSHOT_ID}.`,
			},
		},
	};
});

async function owlat(
	args: string[],
	input = ''
): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		const pending = run('bash', [join(dir, 'scripts', 'owlat'), ...args], {
			env: {
				...process.env,
				PATH: `${stubDir}:${process.env['PATH'] ?? ''}`,
				OWLAT_DIR: dir,
				OWLAT_SKIP_CLI_LINK: '1',
				// What the updater container's environment carries.
				PORT: String(port),
				INSTANCE_SECRET: SECRET,
			},
		});
		// What the operator types at the confirmation prompt.
		pending.child.stdin?.end(input);
		const { stdout, stderr } = await pending;
		return { code: 0, stdout, stderr };
	} catch (error) {
		const failure = error as { code?: number; stdout?: string; stderr?: string };
		return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
	}
}

describe('owlat rollback', () => {
	it('shows the snapshot, then restores exactly that one with the instance secret', async () => {
		const result = await owlat(['rollback', '--yes']);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain('from 0.4.16 to 0.4.17');
		expect(result.stdout).not.toContain('snapshot-id:');
		expect(result.stdout).toContain(`Rolled back to snapshot ${SNAPSHOT_ID}.`);
		expect(seen.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /snapshot', 'POST /rollback']);
		expect(seen.every((r) => r.secret === SECRET)).toBe(true);
		expect(JSON.parse(seen[1]!.body)).toEqual({ snapshot: SNAPSHOT_ID });
	});

	it('restores nothing unless the operator types yes', async () => {
		const declined = await owlat(['rollback'], 'no\n');
		expect(declined.code).not.toBe(0);
		expect(declined.stdout).toContain('nothing was changed');
		expect(seen.map((r) => r.path)).toEqual(['/snapshot']);

		seen = [];
		const confirmed = await owlat(['rollback'], 'yes\n');
		expect(confirmed.code).toBe(0);
		expect(seen.map((r) => r.path)).toEqual(['/snapshot', '/rollback']);
	});

	it('restores nothing when there is no snapshot', async () => {
		answers['GET /snapshot'] = {
			status: 200,
			body: { snapshot: null, description: 'There is no snapshot to roll back to.' },
		};
		const result = await owlat(['rollback', '--yes']);

		expect(result.code).not.toBe(0);
		expect(result.stdout).toContain('There is no snapshot to roll back to.');
		expect(seen.map((r) => r.path)).toEqual(['/snapshot']);
	});

	it("fails with the updater's own reason when the restore fails", async () => {
		answers['POST /rollback'] = {
			status: 500,
			body: {
				success: false,
				error: 'Rolling back failed partway: restoring owlat_redis-data failed.',
			},
		};
		const result = await owlat(['rollback', '--yes']);

		expect(result.code).not.toBe(0);
		expect(result.stdout).toContain('restoring owlat_redis-data failed');
		expect(result.stderr).toContain('did not complete');
	});

	it('refuses an unknown flag before asking the updater anything', async () => {
		const result = await owlat(['rollback', '--force']);

		expect(result.code).toBe(2);
		expect(seen).toEqual([]);
	});
});
