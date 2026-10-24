/**
 * The kill tests' Convex deployment: the stack's self-hosted backend running
 * the current tree's functions, configured, seeded and read the way an
 * operator and a user would.
 *
 * The functions are pushed from a mirror of `apps/api` without its
 * `__tests__` directories (scripts/dev-stack/stage.ts says why), with the
 * repository's own Convex CLI. The seed goes through the public surfaces:
 * `POST /seed/admin` for the owner, BetterAuth for a session and its JWT, and
 * the user-facing `connect` and `migration.start` functions for the external
 * account and its import. Only the Sends are written directly (see
 * `seedQueuedSends`). The outcome is read back from the tables with
 * `convex data`.
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '@owlat/shared/passwordHash';
import { parseAdminKey } from '../dev-stack/envFile';
import { selfHostedCliEnv } from '../dev-stack/convexTarget';
import { syncStage } from '../dev-stack/stage';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Two levels below the root like `apps/api`, and gitignored by the `/.owlat-*` rule. */
const STAGE = join(ROOT, '.owlat-kill-tests', 'api');
const CONVEX_BIN = join(ROOT, 'node_modules', '.bin', 'convex');
/** The origin BetterAuth trusts; nothing listens there, it only has to match. */
const SITE_URL = 'http://localhost:3000';

/** Keys the workers and the deployment share; stack.ts generates them per run. */
export interface WorkerSecrets {
	/** The MTA's API key; the orchestrator queues sends with it. */
	readonly mtaApiKey: string;
	/** The MTA signs its webhooks with it and the deployment verifies them. */
	readonly mtaWebhookSecret: string;
	/** mail-sync presents it and the deployment checks it on raw uploads. */
	readonly mailSyncApiKey: string;
}

const OWNER = {
	email: 'owner@owlat.example',
	name: 'Kill Test Owner',
	password: 'kill-test-owner-password',
};

export interface ImapAccount {
	readonly emailAddress: string;
	readonly host: string;
	readonly port: number;
	readonly password: string;
}

export interface SeededAccount {
	readonly accountId: string;
	readonly mailboxId: string;
}

/** A Send the MTA was handed, as `bindMtaProviderIdentity` leaves it. */
export interface QueuedSend {
	readonly providerMessageId: string;
	readonly email: string;
	readonly subject: string;
}

type Row = Record<string, unknown>;

export class KillBackend {
	private readonly cliEnv: NodeJS.ProcessEnv;

	constructor(
		/** Published host addresses of the backend's API and HTTP-action ports. */
		private readonly urls: { readonly api: string; readonly site: string },
		readonly adminKey: string,
		private readonly instanceSecret: string,
		private readonly secrets: WorkerSecrets
	) {
		this.cliEnv = selfHostedCliEnv(process.env, urls.api, adminKey);
	}

	/** `generate_admin_key.sh` output from the backend container. */
	static adminKeyFrom(output: string): string {
		const key = parseAdminKey(output);
		if (!key) throw new Error('could not read an admin key from the backend');
		return key;
	}

	/** Set the deployment's variables, then push the current tree's functions. */
	deploy(log: (line: string) => void): void {
		// Through stdin, so the secrets never appear in a process listing.
		const variables = {
			INSTANCE_SECRET: this.instanceSecret,
			BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
			SITE_URL,
			MTA_WEBHOOK_SECRET: this.secrets.mtaWebhookSecret,
			MAIL_SYNC_API_KEY: this.secrets.mailSyncApiKey,
		};
		const synced = syncStage(join(ROOT, 'apps', 'api'), STAGE);
		log(`staged apps/api (${synced.copied} copied, ${synced.removed} removed)`);
		this.cli(['env', 'set', '--force'], {
			input: `${Object.entries(variables)
				.map(([key, value]) => `${key}=${value}`)
				.join('\n')}\n`,
		});
		log('pushing the functions');
		this.cli(['deploy', '--yes', '--typecheck', 'disable', '--codegen', 'disable']);
	}

	/**
	 * The owner, signed in, with `mail.external` on. Returns a Convex JWT for
	 * the owner's session in their organization.
	 */
	async signInOwner(): Promise<string> {
		const seeded = await fetch(`${this.urls.site}/seed/admin`, {
			method: 'POST',
			headers: { 'X-Instance-Secret': this.instanceSecret, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				email: OWNER.email,
				name: OWNER.name,
				passwordHash: await hashPassword(OWNER.password),
				flags: { 'mail.external': true },
			}),
		});
		if (!seeded.ok)
			throw new Error(`/seed/admin answered ${seeded.status}: ${await seeded.text()}`);

		const jar = new Map<string, string>();
		const auth = async (path: string, body?: unknown): Promise<Response> => {
			const response = await fetch(`${this.urls.site}/api/auth${path}`, {
				method: body === undefined ? 'GET' : 'POST',
				headers: {
					Origin: SITE_URL,
					'Content-Type': 'application/json',
					Cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
			if (!response.ok) throw new Error(`${path} answered ${response.status}`);
			for (const cookie of response.headers.getSetCookie()) {
				const pair = cookie.split(';', 1)[0]!;
				const split = pair.indexOf('=');
				jar.set(pair.slice(0, split), pair.slice(split + 1));
			}
			return response;
		};
		await auth('/sign-in/email', { email: OWNER.email, password: OWNER.password });
		const organizations = (await (await auth('/organization/list')).json()) as Array<{
			id: string;
		}>;
		if (organizations.length !== 1) {
			throw new Error(`the owner belongs to ${organizations.length} organizations, expected 1`);
		}
		// The token carries the active organization; the seeded session has none yet.
		await auth('/organization/set-active', { organizationId: organizations[0]!.id });
		const { token } = (await (await auth('/convex/token')).json()) as { token: string };
		return token;
	}

	/** Connect the owner's external mailbox and start importing its history. */
	async connectAndImport(token: string, account: ImapAccount): Promise<SeededAccount> {
		const connected = (await this.call(token, 'action', 'mail/external/accountsActions:connect', {
			emailAddress: account.emailAddress,
			imapHost: account.host,
			imapPort: account.port,
			// STARTTLS on 143; the worker refuses a non-loopback host without TLS.
			isImapSecure: false,
			smtpHost: account.host,
			smtpPort: 587,
			isSmtpSecure: false,
			username: account.emailAddress,
			password: account.password,
		})) as { externalAccountId: string; mailboxId: string };
		await this.call(token, 'mutation', 'mail/migration:start', {});
		return { accountId: connected.externalAccountId, mailboxId: connected.mailboxId };
	}

	/**
	 * Write Sends in the state the governed path leaves them in when it hands
	 * them to the MTA: `queued`, with the MTA's deterministic message id bound
	 * as `providerMessageId`. The MTA then receives them through `/send/system`
	 * (mtaScenario.ts), and every later transition is the backend's own webhook
	 * handling.
	 */
	seedQueuedSends(sends: readonly QueuedSend[], scratchDir: string): void {
		const file = join(scratchDir, 'sends.jsonl');
		const queuedAt = Date.now();
		writeFileSync(
			file,
			sends
				.map((send) =>
					JSON.stringify({
						kind: 'transactional',
						email: send.email,
						subject: send.subject,
						status: 'queued',
						queuedAt,
						providerMessageId: send.providerMessageId,
						providerType: 'mta',
					})
				)
				.join('\n')
		);
		this.cli([
			'import',
			'--table',
			'transactionalSends',
			'--append',
			'--yes',
			'--format',
			'jsonLines',
			file,
		]);
	}

	/** Every row of `table`; the kill tests' tables hold tens of rows. */
	rows(table: string): Row[] {
		const output = this.cli(['data', table, '--limit', '10000', '--format', 'jsonLines']);
		return output
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line.startsWith('{'))
			.map((line) => JSON.parse(line) as Row);
	}

	/** One call through Convex's public HTTP API, as the signed-in owner. */
	private async call(
		token: string,
		kind: 'mutation' | 'action',
		path: string,
		args: Record<string, unknown>
	): Promise<unknown> {
		const response = await fetch(`${this.urls.api}/api/${kind}`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ path, args, format: 'json' }),
		});
		const answer = (await response.json()) as {
			status?: string;
			value?: unknown;
			errorMessage?: string;
		};
		if (answer.status !== 'success') {
			throw new Error(
				`${path} failed (${response.status}): ${answer.errorMessage ?? 'no message'}`
			);
		}
		return answer.value;
	}

	private cli(args: readonly string[], options: { input?: string } = {}): string {
		const result = spawnSync(CONVEX_BIN, args, {
			cwd: STAGE,
			env: this.cliEnv,
			input: options.input,
			encoding: 'utf8',
			maxBuffer: 64 * 1024 * 1024,
		});
		if (result.status !== 0) {
			throw new Error(`convex ${args[0]} failed:\n${result.stderr}${result.stdout}`);
		}
		return result.stdout;
	}
}
