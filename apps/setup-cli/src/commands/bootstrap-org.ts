/**
 * `owlat-setup bootstrap-org` — create the first admin user + singleton org.
 *
 * Calls `POST /seed/admin` on the local Convex backend with a scrypt-hashed
 * password matching BetterAuth's format. Idempotent: a 409 response means
 * the admin already exists, and we exit 0 with the existing email surfaced.
 *
 * Inputs:
 *   - --email, --name, --password (or interactive prompts)
 *   - --assume-yes / -y to skip prompts (requires the three flags)
 *
 * Used standalone, and also called by `quickstart` after the docker stack
 * comes up healthy.
 */

import { intro, outro, text, password as passwordPrompt, isCancel, log } from '@clack/prompts';
import { progressSpinner } from '../lib/progress';
import pc from 'picocolors';
import { hashPassword } from '../lib/passwordHash';
import { loadBackendContext, postJson } from '../lib/backend';
import { loadFlagState } from '../lib/flagState';
import { resolveFlags } from '@owlat/shared/featureFlags';

interface RunOptions {
	web: boolean;
	terminal: boolean;
	assumeYes: boolean;
	owlatDir: string;
	configFile?: string;
	positional: string[];
	args: string[];
}

export interface BootstrapInput {
	email?: string;
	name?: string;
	password?: string;
}

export async function runBootstrapOrg(opts: RunOptions): Promise<number> {
	intro(pc.bgCyan(pc.black(' Bootstrap Admin & Organization ')));

	const fromArgs = parseArgs(opts.args);

	const email = fromArgs.email ?? await ask('Admin email', validateEmail, opts.assumeYes ? 'dev@example.com' : undefined);
	if (email === null) return 1;

	const name = fromArgs.name ?? await ask('Admin display name', () => undefined, opts.assumeYes ? 'Dev Admin' : undefined);
	if (name === null) return 1;

	const password = fromArgs.password ?? await askPassword(opts.assumeYes ? 'devpassword12345' : undefined);
	if (password === null) return 1;

	const exitCode = await bootstrap({ email, name, password }, opts);
	return exitCode;
}

export async function bootstrap(
	input: Required<BootstrapInput>,
	opts: RunOptions,
	baseUrlOverride?: string,
): Promise<number> {
	const s = progressSpinner();
	s.start('Hashing password (scrypt)');
	const passwordHash = await hashPassword(input.password);
	s.stop(pc.green('Password hashed'));

	const ctx = await loadBackendContext(opts.owlatDir, baseUrlOverride);

	// Carry the CLI-side flag mirror so the backend persists the chosen
	// features onto instanceSettings.featureFlags (else the runtime falls back
	// to compiled-in defaults and the selections are silently dropped).
	const flags = resolveFlags(await loadFlagState(opts.owlatDir));

	s.start(`POST ${ctx.baseUrl}/seed/admin`);
	let response;
	try {
		response = await postJson<{ success?: boolean; userId?: string; error?: string }>(ctx, {
			path: '/seed/admin',
			body: { email: input.email, name: input.name, passwordHash, flags },
		});
	} catch (e) {
		s.stop(pc.red(`Failed: ${(e as Error).message}`));
		log.error('Is the docker stack up? Try `docker compose up -d` first.');
		return 1;
	}

	if (response.status === 201) {
		s.stop(pc.green('Admin created'));
		outro(`${pc.green('Bootstrap complete!')} Sign in at http://localhost:3000 as ${pc.cyan(input.email)}.`);
		return 0;
	}

	if (response.status === 409) {
		s.stop(pc.yellow('Admin already exists — nothing to do.'));
		outro(`${pc.dim('Tip:')} run ${pc.cyan('bunx owlat-setup reset')} to wipe the instance back to blank.`);
		return 0;
	}

	const message = response.body?.error ?? `Unexpected status ${response.status}`;
	s.stop(pc.red(`Failed: ${message}`));
	return 1;
}

function parseArgs(args: string[]): BootstrapInput {
	const out: BootstrapInput = {};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (!arg.startsWith('--')) continue;
		const eq = arg.indexOf('=');
		const [k, v] = eq === -1 ? [arg, args[i + 1]] : [arg.slice(0, eq), arg.slice(eq + 1)];
		if (k === '--email') out.email = v;
		else if (k === '--name') out.name = v;
		else if (k === '--password') out.password = v;
	}
	return out;
}

type Validator = (v: string) => string | undefined;

async function ask(message: string, validate: Validator, defaultValue?: string): Promise<string | null> {
	if (defaultValue !== undefined) {
		const err = validate(defaultValue);
		if (err) {
			log.error(`Default for ${message} is invalid: ${err}`);
			return null;
		}
		return defaultValue;
	}
	const result = await text({ message, validate });
	if (isCancel(result)) return null;
	return result;
}

async function askPassword(defaultValue?: string): Promise<string | null> {
	if (defaultValue !== undefined) return defaultValue;
	const result = await passwordPrompt({
		message: 'Admin password (min 12 chars)',
		validate: (v) => (v.length < 12 ? 'Password must be at least 12 characters' : undefined),
		mask: '•',
	});
	if (isCancel(result)) return null;
	return result;
}

function validateEmail(v: string): string | undefined {
	return /^.+@.+\..+$/.test(v) ? undefined : 'Enter a valid email';
}
