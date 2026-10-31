/**
 * The kill-test stack as the orchestrator sees it: one Compose project with a
 * unique name (removed by that name, volumes included), the throwaway TLS
 * material the IMAP fixture serves, the Convex backend, and the world
 * container's control API.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KillBackend, type WorkerSecrets } from './backend';
import { makeImapCertificates } from './certificates';
import type { HoldRule } from './world/smtpSink';
import { decodeWorldState, parseWire, type WorldState } from './world/wire';

/** One control long-poll; `waitFor` chains them up to its deadline. */
const LONG_POLL_MS = 60_000;
const COMPOSE_FILE = join(dirname(fileURLToPath(import.meta.url)), 'compose.yml');

const secret = (): string => randomBytes(32).toString('hex');

export class KillStack {
	readonly project = `owlat-kill-${process.pid}-${Date.now().toString(36)}`;
	/** The run's scratch directory (private): seed files, and the TLS material in `certs/`. */
	readonly scratchDir = mkdtempSync(join(tmpdir(), 'owlat-kill-tests-'));
	/** Mounted into dovecot and mail-sync; the only part of the scratch directory they see. */
	private readonly certDir = join(this.scratchDir, 'certs');
	/** The backend derives its admin key from this; new for every run. */
	private readonly instanceSecret = secret();
	/**
	 * The keys the workers and the backend share, new for every run: no
	 * credential-shaped literal is committed, and a leftover stack accepts
	 * nothing a later run sends.
	 */
	readonly secrets: WorkerSecrets = {
		mtaApiKey: secret(),
		mtaWebhookSecret: secret(),
		mailSyncApiKey: secret(),
	};
	/** Only the MTA reads these. */
	private readonly mtaSecret = secret();
	private readonly bounceVerpKey = secret();
	private adminKey = '';
	private worldUrl: string | undefined;

	constructor() {
		makeImapCertificates(this.certDir);
	}

	compose(args: readonly string[], options: { input?: string; inherit?: boolean } = {}): string {
		const result = spawnSync(
			'docker',
			['compose', '-p', this.project, '-f', COMPOSE_FILE, ...args],
			{
				env: {
					...process.env,
					KILL_CERT_DIR: this.certDir,
					KILL_INSTANCE_SECRET: this.instanceSecret,
					KILL_MTA_API_KEY: this.secrets.mtaApiKey,
					KILL_MTA_SECRET: this.mtaSecret,
					KILL_BOUNCE_VERP_KEY: this.bounceVerpKey,
					KILL_MTA_WEBHOOK_SECRET: this.secrets.mtaWebhookSecret,
					KILL_MAIL_SYNC_API_KEY: this.secrets.mailSyncApiKey,
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
			this.instanceSecret,
			this.secrets
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

	/** What the world observed; an answer of the wrong shape fails the run before any verdict. */
	async state(): Promise<WorldState> {
		const response = await this.world('/control/state');
		if (!response.ok) throw new Error(`/control/state answered ${response.status}`);
		return decodeWorldState(parseWire(await response.text(), '/control/state'));
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
