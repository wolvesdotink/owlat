/**
 * The kill-test stack as the orchestrator sees it: one Compose project with a
 * unique name (removed by that name, volumes included), the throwaway TLS
 * material the IMAP fixture serves, the Convex backend, and the world
 * container's control API.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KillBackend } from './backend';
import type { HoldRule } from './world/smtpSink';

/** One control long-poll; `waitFor` chains them up to its deadline. */
const LONG_POLL_MS = 60_000;
const COMPOSE_FILE = join(dirname(fileURLToPath(import.meta.url)), 'compose.yml');

/**
 * A CA and an `imap.owlat.test` certificate it signs, valid for a day. The
 * mail-sync worker verifies its IMAP peer exactly as in production and is only
 * told to trust this CA, so no TLS check is relaxed for the test.
 */
export function makeImapCertificates(dir: string): void {
	const openssl = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
	const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
	openssl(
		'req',
		'-x509',
		...ec,
		'-keyout',
		'ca.key',
		'-out',
		'ca.crt',
		'-days',
		'1',
		'-subj',
		'/CN=owlat-kill-tests-ca'
	);
	openssl('req', ...ec, '-keyout', 'imap.key', '-out', 'imap.csr', '-subj', '/CN=imap.owlat.test');
	writeFileSync(
		join(dir, 'imap.ext'),
		'subjectAltName=DNS:imap.owlat.test\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n'
	);
	openssl(
		'x509',
		'-req',
		'-in',
		'imap.csr',
		'-CA',
		'ca.crt',
		'-CAkey',
		'ca.key',
		'-CAcreateserial',
		'-out',
		'imap.crt',
		'-days',
		'1',
		'-extfile',
		'imap.ext'
	);
	// Read by dovecot's master and the worker's `node` user inside the containers.
	execFileSync('chmod', ['0644', 'ca.crt', 'imap.crt', 'imap.key'], { cwd: dir });
}

export class KillStack {
	readonly project = `owlat-kill-${process.pid}-${Date.now().toString(36)}`;
	/** The run's scratch directory: TLS material, seed files. */
	readonly scratchDir = mkdtempSync(join(tmpdir(), 'owlat-kill-tests-'));
	/** The backend derives its admin key from this; new for every run. */
	private readonly instanceSecret = randomBytes(32).toString('hex');
	private adminKey = '';
	private worldUrl: string | undefined;

	constructor() {
		makeImapCertificates(this.scratchDir);
	}

	compose(args: readonly string[], options: { input?: string; inherit?: boolean } = {}): string {
		const result = spawnSync(
			'docker',
			['compose', '-p', this.project, '-f', COMPOSE_FILE, ...args],
			{
				env: {
					...process.env,
					KILL_CERT_DIR: this.scratchDir,
					KILL_INSTANCE_SECRET: this.instanceSecret,
					KILL_ADMIN_KEY: this.adminKey,
				},
				input: options.input,
				encoding: 'utf8',
				stdio: options.inherit ? 'inherit' : 'pipe',
				maxBuffer: 64 * 1024 * 1024,
			}
		);
		if (result.status !== 0) {
			throw new Error(`docker compose ${args.join(' ')} failed:\n${result.stderr ?? ''}`);
		}
		return result.stdout ?? '';
	}

	/** The running backend, with its admin key; the workers started after this get the key. */
	backend(): KillBackend {
		this.adminKey ||= KillBackend.adminKeyFrom(
			this.compose(['exec', '-T', 'convex', './generate_admin_key.sh'])
		);
		return new KillBackend(
			{
				api: `http://${this.address('convex', 3210)}`,
				site: `http://${this.address('convex', 3211)}`,
			},
			this.adminKey,
			this.instanceSecret
		);
	}

	/** The service's container id; the kill and the restart address the same container. */
	container(service: string): string {
		const id = this.compose(['ps', '-a', '-q', service]).trim();
		if (!id) throw new Error(`no ${service} container`);
		return id;
	}

	/** `docker kill -s KILL`: no shutdown hook, no drain, no flush. */
	kill(service: string): void {
		execFileSync('docker', ['kill', '-s', 'KILL', this.container(service)], { stdio: 'pipe' });
	}

	/** Start the same container again: same volumes, same Redis, same configuration. */
	restart(service: string): void {
		execFileSync('docker', ['start', this.container(service)], { stdio: 'pipe' });
	}

	/** The published host address of a service port, e.g. `127.0.0.1:49153`. */
	address(service: string, port: number): string {
		return this.compose(['port', service, String(port)]).trim();
	}

	async world(path: string, init?: RequestInit): Promise<Response> {
		this.worldUrl ??= `http://${this.address('world', 3210)}`;
		return await fetch(`${this.worldUrl}${path}`, init);
	}

	/**
	 * Resolve when the world has recorded event `key`. The world answers the
	 * moment the event exists (a long-poll, not a poll loop); `timeoutMs` only
	 * turns a run that never gets there into a failure instead of a hang. One
	 * request waits at most a minute, under bun's own five-minute fetch timeout.
	 */
	async waitFor(key: string, timeoutMs: number): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		for (let remaining = timeoutMs; remaining > 0; remaining = deadline - Date.now()) {
			const params = new URLSearchParams({
				key,
				timeoutMs: String(Math.min(remaining, LONG_POLL_MS)),
			});
			const response = await this.world(`/control/wait?${params}`);
			if (response.status === 200) return;
			if (response.status !== 408)
				throw new Error(`waiting for ${key} answered ${response.status}`);
		}
		throw new Error(`timed out after ${timeoutMs} ms waiting for ${key}`);
	}

	async holdSmtp(rules: readonly HoldRule[]): Promise<void> {
		await this.post('/control/smtp/hold', { rules });
	}

	/** Commit the ingest of these UIDs at the backend, then never answer the worker. */
	async holdIngest(uids: readonly number[]): Promise<void> {
		await this.post('/control/convex/hold-ingest', { uids });
	}

	async state<T>(): Promise<T> {
		return (await (await this.world('/control/state')).json()) as T;
	}

	logs(services: readonly string[]): string {
		try {
			return this.compose(['logs', '--no-color', '--tail', '300', ...services]);
		} catch (error) {
			return String(error);
		}
	}

	down(): void {
		try {
			this.compose(['down', '--volumes', '--remove-orphans', '--timeout', '5']);
		} finally {
			rmSync(this.scratchDir, { recursive: true, force: true });
		}
	}

	private async post(path: string, body: unknown): Promise<void> {
		const response = await this.world(path, { method: 'POST', body: JSON.stringify(body) });
		if (!response.ok) throw new Error(`${path} answered ${response.status}`);
	}
}
