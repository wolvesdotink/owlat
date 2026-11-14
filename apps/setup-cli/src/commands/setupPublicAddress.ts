/**
 * Terminal-wizard section: the public HTTPS address, asked once as a domain.
 *
 * Links in sign-up verification, password-reset and invitation mail point at
 * `SITE_URL`, and once it is public it is the only origin sign-in trusts. So the
 * answer is only taken after the hostnames are shown to reach this server on
 * ports 80 and 443 (`lib/publicHostCheck.ts`), and it is written together with
 * the Caddy edge that serves it (`lib/publicAddress.ts`, the same writer the
 * config file's `network` section uses). An empty answer keeps the install on
 * localhost, which stays the default.
 *
 * A re-run of `owlat setup` on an existing install can change only this answer
 * (`runPublicAddressOnly`): add a public address later, move it, or go back to
 * localhost.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { confirm, isCancel, log, outro, select, text } from '@clack/prompts';
import pc from 'picocolors';
import { renderComposeOverrideYaml, parseComposeProfileList } from '@owlat/shared/composeOverride';
import { readEnv, writeEnv, type EnvMap } from '../lib/env';
import { progressSpinner } from '../lib/progress';
import {
	bundledEdgeNetwork,
	domainOfNetwork,
	isPublicDomainName,
	networkFromDomain,
	networkHosts,
	withLocalNetwork,
	withPublicNetwork,
	writeCaddyfile,
	type PublicNetwork,
} from '../lib/publicAddress';
import { checkPublicHosts, defaultHostCheckDeps, type HostCheckDeps } from '../lib/publicHostCheck';
import { isValidEmail } from '../lib/validators';

export type PublicAddressAnswer =
	| { network: PublicNetwork; email: string }
	| { network: undefined; email?: undefined };

interface AskOptions {
	existingEnv: EnvMap;
	/** Pre-fills the certificate contact, e.g. the admin email just entered. */
	contactEmail?: string;
	/** Offer "stay on localhost" after a failed check (the full wizard does). */
	allowStayLocal: boolean;
	deps?: HostCheckDeps;
}

/**
 * Ask for the public domain and check it. `null` when the operator cancelled or
 * gave up after a failed check; nothing has been written either way.
 */
export async function askPublicAddress(opts: AskOptions): Promise<PublicAddressAnswer | null> {
	const current = bundledEdgeNetwork(opts.existingEnv);
	let initialDomain = current ? domainOfNetwork(current) : '';
	for (;;) {
		const domain = await text({
			message:
				'Public domain for this server (Owlat answers at owlat.<domain>, api.<domain> and rest.api.<domain>). Leave empty to stay on localhost.',
			placeholder: 'example.com',
			initialValue: initialDomain,
			validate: (v) =>
				!v?.trim() || isPublicDomainName(v) ? undefined : 'Enter a domain such as example.com',
		});
		if (isCancel(domain)) return null;
		if (!domain.trim()) return { network: undefined };
		initialDomain = domain.trim();

		const network = networkFromDomain(domain);
		const hosts = networkHosts(network);
		log.info(
			`Owlat will be served over HTTPS by Caddy at:\n${hosts.map((h) => `  https://${h}`).join('\n')}\n` +
				'Each needs an A record pointing at this server, and ports 80 and 443 open.'
		);
		const email = await text({
			message: 'Email for Let’s Encrypt certificate notices',
			initialValue: opts.contactEmail ?? '',
			validate: (v) => (isValidEmail(v?.trim() ?? '') ? undefined : 'Enter a valid email'),
		});
		if (isCancel(email)) return null;
		// The address Caddy already serves: its ports are Caddy's, and nothing moves.
		if (current && network.siteUrl === current.siteUrl) return { network, email: email.trim() };

		const s = progressSpinner();
		s.start('Checking that these names reach this server on ports 80 and 443');
		const problems = await checkPublicHosts(hosts, opts.deps ?? defaultHostCheckDeps);
		if (problems.length === 0) {
			s.stop(pc.green('All three names reach this server on ports 80 and 443'));
			return { network, email: email.trim() };
		}
		s.stop(pc.red('The public address is not ready; nothing was changed'));
		log.error(problems.join('\n'));
		const next = await select({
			message: 'What now?',
			options: [
				{ label: 'Check again (after fixing DNS or the firewall)', value: 'retry' },
				...(opts.allowStayLocal
					? [
							{
								label: 'Stay on localhost for now (add it later with `owlat setup`)',
								value: 'local',
							},
						]
					: []),
				{ label: 'Cancel', value: 'cancel' },
			],
		});
		if (isCancel(next) || next === 'cancel') return null;
		if (next === 'local') return { network: undefined };
	}
}

/** The closing lines for a chosen public address. */
export function publicAddressNextSteps(network: PublicNetwork): string[] {
	return [
		`Sign in at ${network.siteUrl} once Caddy has its certificates (a minute after the stack starts).`,
		'Sign-in on http://localhost:3000 stops working: the public address is now the only origin it trusts.',
	];
}

async function caddyContactEmail(owlatDir: string): Promise<string | undefined> {
	try {
		const caddyfile = await readFile(join(owlatDir, 'Caddyfile'), 'utf-8');
		return /^\s*email\s+(\S+)\s*$/m.exec(caddyfile)?.[1];
	} catch {
		return undefined;
	}
}

/** Write `.env`'s profiles into the override's marker list as well, so both agree. */
async function writeEnvAndOverride(envPath: string, overridePath: string, env: EnvMap) {
	await writeEnv(envPath, env);
	await writeFile(
		overridePath,
		renderComposeOverrideYaml(parseComposeProfileList(env['COMPOSE_PROFILES'] ?? '')),
		'utf-8'
	);
}

/**
 * Change only the public address of an existing install. Writes `.env`, the
 * compose override's profile list and the Caddyfile, or nothing at all.
 */
export async function runPublicAddressOnly(args: {
	owlatDir: string;
	envPath: string;
	overridePath: string;
	deps?: HostCheckDeps;
}): Promise<number> {
	const existingEnv = await readEnv(args.envPath);
	const current = bundledEdgeNetwork(existingEnv);
	const answer = await askPublicAddress({
		existingEnv,
		contactEmail:
			(await caddyContactEmail(args.owlatDir)) ?? existingEnv['DEFAULT_FROM_EMAIL'] ?? undefined,
		allowStayLocal: false,
		...(args.deps ? { deps: args.deps } : {}),
	});
	if (answer === null) {
		outro(pc.yellow('Nothing was changed.'));
		return 1;
	}
	const apply = `Apply it with ${pc.cyan('owlat apply')}.`;
	if (!answer.network) {
		if (!current) {
			outro('This install already stays on localhost. Nothing was changed.');
			return 0;
		}
		const back = await confirm({
			message: `Stop serving ${current.siteUrl} and go back to http://localhost:3000?`,
			initialValue: false,
		});
		if (isCancel(back) || !back) {
			outro(pc.yellow('Nothing was changed.'));
			return 0;
		}
		await writeEnvAndOverride(args.envPath, args.overridePath, withLocalNetwork(existingEnv));
		outro(
			`${pc.green('Back on localhost.')} ${apply} Then stop Caddy with ${pc.cyan('docker compose --profile tls rm -sf caddy')}.`
		);
		return 0;
	}
	await writeEnvAndOverride(
		args.envPath,
		args.overridePath,
		withPublicNetwork(existingEnv, answer.network)
	);
	await writeCaddyfile(args.owlatDir, answer.network, answer.email);
	outro(
		[
			pc.green(`Public address set: ${answer.network.siteUrl}`),
			`${apply} It starts Caddy and pushes the new URLs to the backend.`,
			...publicAddressNextSteps(answer.network),
		].join('\n')
	);
	return 0;
}
