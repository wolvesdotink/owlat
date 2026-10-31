/**
 * The interactive and printed parts of `owlat-setup quickstart`: its flags,
 * the mode and yes/no prompts, the DNS instructions for a domain install and
 * the closing summary.
 */

import { select, isCancel, confirm, text } from '@clack/prompts';
import pc from 'picocolors';
import { isOwnSendProviderKind } from '@owlat/shared/sendProviderCatalog';
import type { SetupConfig } from '../lib/setupConfig';
import { isValidEmail } from '../lib/validators';

export type Mode = 'populated' | 'blank' | 'custom';

export interface ParsedFlags {
	mode?: Mode;
	email?: string;
	name?: string;
	password?: string;
	skipSeed?: boolean;
	forceSeed?: boolean;
	restart?: boolean;
}

export function parseFlags(args: string[]): ParsedFlags {
	const out: ParsedFlags = {};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (!arg.startsWith('--')) continue;
		const eq = arg.indexOf('=');
		const [k, raw] = eq === -1 ? [arg, args[i + 1]] : [arg.slice(0, eq), arg.slice(eq + 1)];
		if (k === '--mode' && (raw === 'populated' || raw === 'blank' || raw === 'custom'))
			out.mode = raw;
		else if (k === '--email') out.email = raw;
		else if (k === '--name') out.name = raw;
		else if (k === '--password') out.password = raw;
		else if (k === '--no-seed') out.skipSeed = true;
		else if (k === '--seed') out.forceSeed = true;
		else if (k === '--restart') out.restart = true;
	}
	return out;
}

export async function pickMode(
	fromFlag: Mode | undefined,
	assumeYes: boolean
): Promise<Mode | null> {
	if (fromFlag) return fromFlag;
	if (assumeYes) return 'populated';
	const options: Array<{ label: string; value: Mode; hint?: string }> = [
		{
			label: 'Explore with sample data — admin + a realistic populated instance',
			value: 'populated',
			hint: 'contacts, topics, templates, a sent campaign; remove it any time with `owlat sample-data remove`',
		},
		{
			label: 'Blank — no admin, no data',
			value: 'blank',
			hint: 'test the real /auth/register signup flow',
		},
		{
			label: 'Custom — decide per step',
			value: 'custom',
		},
	];
	const choice = await select({
		message: 'How do you want to start?',
		options,
		initialValue: 'populated',
	});
	if (isCancel(choice)) return null;
	return choice as Mode;
}

export async function askYesNo(
	message: string,
	initial: boolean,
	assumeYes: boolean
): Promise<boolean> {
	if (assumeYes) return initial;
	const result = await confirm({ message, initialValue: initial });
	if (isCancel(result)) return false;
	return result;
}

export async function promptEmail(): Promise<string | undefined> {
	const result = await text({
		message: 'Admin email',
		validate: (v) => (isValidEmail(v ?? '') ? undefined : 'Enter a valid email'),
	});
	if (isCancel(result)) return undefined;
	return result;
}

export async function promptText(message: string): Promise<string | undefined> {
	const result = await text({ message });
	if (isCancel(result)) return undefined;
	return result;
}

/**
 * The DNS records a domain install needs before its public URLs work. The
 * server's own public IP isn't reliably known from inside the box, so the
 * target is described rather than printed.
 */
export function dnsInstructions(config: SetupConfig): string[] {
	if (!config.network) return [];
	const hosts = [
		config.network.siteUrl,
		config.network.convexUrl,
		config.network.convexSiteUrl,
	].map((u) => new URL(u).hostname);
	const pad = Math.max(...hosts.map((h) => h.length)) + 2;
	const lines = [
		"DNS records required for public access (point them at this server's public IP):",
		...hosts.map((h) => `  ${h.padEnd(pad)}A    <server IP>`),
	];
	// The OWN arm, asked through the catalog rather than spelled again: only
	// our own MTA needs an EHLO A record and a bounce-domain MX pointed here.
	if (isOwnSendProviderKind(config.sending?.provider) && config.domain) {
		lines.push(
			`  ${config.domain.ehloHostname.padEnd(pad)}A    <server IP>`,
			...(config.domain.bounceDomain
				? [`  ${config.domain.bounceDomain.padEnd(pad)}MX   ${config.domain.ehloHostname}`]
				: []),
			// PTR is not a zone record — it is set wherever the IP is rented, and no
			// mail leaves the box until it matches. It earns its own line.
			"Reverse DNS (PTR), set in your VPS provider's console, not your DNS zone:",
			`  <server IP>${' '.repeat(Math.max(1, pad - 11))}PTR  ${config.domain.ehloHostname}`
		);
	}
	lines.push(
		'TLS certificates are issued automatically once DNS resolves; keep ports 80/443 open.'
	);
	return lines;
}

export function formatSummary(args: { mode: Mode; adminEmail?: string; baseUrl: string }): string {
	const lines: string[] = [pc.green('Quickstart complete!')];
	lines.push('');
	lines.push(`Web app:   ${pc.cyan('http://localhost:3000')}`);
	lines.push(`Convex:    ${pc.cyan(args.baseUrl)}`);
	if (args.mode === 'blank') {
		lines.push(`Mode:      ${pc.yellow('Blank — sign up at /auth/register')}`);
	} else if (args.adminEmail) {
		lines.push(`Admin:     ${pc.cyan(args.adminEmail)}`);
	}
	lines.push('');
	lines.push(pc.dim('View logs:  docker compose logs -f web'));
	if (args.mode === 'populated') {
		lines.push(pc.dim('Sample data: owlat sample-data remove   (deletes only the sample rows)'));
	}
	lines.push(pc.dim('Wipe + retest signup:  bunx owlat-setup reset'));
	// Backups are operator-owned: there is no managed/off-box backup, so always
	// spell out the command and what it protects. This block must stay even in
	// blank mode — a fresh install finishing with no backup plan is the gap.
	lines.push('');
	lines.push(
		pc.bold('Back up your data — nothing is backed up automatically until you turn it on:')
	);
	lines.push(
		`  ${pc.cyan('owlat backup')}                  one-off snapshot of the Convex data volume (your database), Redis + .env`
	);
	lines.push(
		`  ${pc.cyan('owlat backup-schedule enable')}  schedule automatic backups (daily; systemd timer, cron fallback)`
	);
	lines.push(
		pc.dim(
			'  Recommended: run "owlat backup-schedule enable" for daily backups before you put real data in.'
		)
	);
	return lines.join('\n');
}
