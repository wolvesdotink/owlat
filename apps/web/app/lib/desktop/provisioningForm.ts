/**
 * Wizard form helpers for the desktop "set up a new server" flow.
 *
 * Pure, framework-free building blocks that the setup wizard binds to but that
 * are not part of the SSH/installer orchestration core in `provisioning.ts`:
 *  - live admin-password length/strength + confirm validation (gates submit);
 *  - server-IP resolution and the DNS record table (real IP vs. flagged
 *    placeholder, plus SPF/DMARC starter records for MTA installs);
 *  - the post-install secrets wipe command and the failing-step stderr tail.
 *
 * Split out of `provisioning.ts` to keep that file under the size cap; the SSH
 * orchestration there stays focused on transport + timeline.
 */
import { type InstanceHostnames, setupConfigPath } from './provisioning';

// ---- admin password validation (live, pre-submit) --------------------------

export const MIN_ADMIN_PASSWORD_LENGTH = 12;

export type PasswordStrength = 'empty' | 'weak' | 'fair' | 'strong';

export interface PasswordAssessment {
	length: number;
	meetsMinLength: boolean;
	strength: PasswordStrength;
	/** Short human label for the strength meter. */
	label: string;
	/** Filled meter segments, 0–4. */
	score: number;
}

/**
 * Live length + strength read-out for the admin password, shown as the user
 * types (before provisioning starts). Strength blends length with character
 * variety; nothing below {@link MIN_ADMIN_PASSWORD_LENGTH} ever reads above
 * "weak" — the minimum is the floor, not a strong password.
 */
export function assessPassword(password: string): PasswordAssessment {
	const length = password.length;
	const meetsMinLength = length >= MIN_ADMIN_PASSWORD_LENGTH;
	if (length === 0) {
		return { length, meetsMinLength: false, strength: 'empty', label: 'Enter a password', score: 0 };
	}
	let variety = 0;
	if (/[a-z]/.test(password)) variety++;
	if (/[A-Z]/.test(password)) variety++;
	if (/\d/.test(password)) variety++;
	if (/[^A-Za-z0-9]/.test(password)) variety++;
	if (!meetsMinLength) {
		return { length, meetsMinLength, strength: 'weak', label: `Too short (${length}/${MIN_ADMIN_PASSWORD_LENGTH})`, score: 1 };
	}
	if (length >= 16 && variety >= 3) {
		return { length, meetsMinLength, strength: 'strong', label: 'Strong', score: 4 };
	}
	if (length >= 14 || variety >= 3) {
		return { length, meetsMinLength, strength: 'fair', label: 'Fair', score: 3 };
	}
	return { length, meetsMinLength, strength: 'fair', label: 'OK', score: 2 };
}

export interface AdminPasswordCheck {
	ok: boolean;
	error: string | null;
}

/**
 * Gate provisioning on the admin password meeting the length floor AND matching
 * its confirmation. Pure so the wizard's submit handler and a unit test share
 * one rule (the form previously checked only the length, only on submit).
 */
export function validateAdminPassword(password: string, confirm: string): AdminPasswordCheck {
	if (password.length < MIN_ADMIN_PASSWORD_LENGTH) {
		return { ok: false, error: `Admin password must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters.` };
	}
	if (password !== confirm) {
		return { ok: false, error: 'The two passwords do not match.' };
	}
	return { ok: true, error: null };
}

// ---- DNS records + server-IP resolution ------------------------------------

/** Shown in the A-record column when no real server IP is known yet. */
export const SERVER_IP_PLACEHOLDER = "your server's public IP";

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Whether a string is a dotted-quad IPv4 address (each octet ≤ 255). */
export function isIpv4(value: string): boolean {
	const v = value.trim();
	if (!IPV4_RE.test(v)) return false;
	return v.split('.').every((o) => Number(o) <= 255);
}

/**
 * Whether a string is a valid IPv6 address. Handles the `::` zero-run
 * compression (at most once) and full eight-group form; good enough to reject
 * junk output from the remote IP probe without a full RFC-grade parser.
 */
export function isIpv6(value: string): boolean {
	const v = value.trim();
	if (!v.includes(':')) return false;
	const isHextet = (h: string): boolean => /^[0-9a-fA-F]{1,4}$/.test(h);
	const runs = v.split('::');
	if (runs.length > 2) return false;
	if (runs.length === 2) {
		const head = runs[0] ? runs[0].split(':') : [];
		const tail = runs[1] ? runs[1].split(':') : [];
		if (head.length + tail.length > 7) return false;
		return [...head, ...tail].every(isHextet);
	}
	const groups = v.split(':');
	return groups.length === 8 && groups.every(isHextet);
}

/**
 * Extract the server's public IP from the remote probe's raw output: the first
 * line that is a valid IPv4 or IPv6 address, else null (empty output, an error
 * message, or anything unparseable). Pure and fail-soft — the wizard falls back
 * to the manual-paste placeholder when this returns null.
 */
/**
 * Read-only probe for the server's public IP over the existing SSH session,
 * used to auto-fill the DNS A-record target when the operator connected by
 * hostname (so we cannot infer the IP from the SSH address). Tries a public
 * echo service first, then falls back to the default-route source address.
 * No user input is interpolated — the command is a fixed string, so it is
 * injection-safe; callers treat any failure/empty output as "unknown".
 */
export function detectPublicIpCommand(): string {
	return 'curl -fsS https://api.ipify.org 2>/dev/null || ip route get 1.1.1.1 2>/dev/null | awk \'{print $7; exit}\'';
}

export function parsePublicIp(output: string): string | null {
	for (const raw of output.split(/[\r\n]+/)) {
		const token = raw.trim();
		if (!token) continue;
		if (isIpv4(token)) return token;
		if (isIpv6(token)) return token;
	}
	return null;
}

/**
 * The IP to drop into the A records: the SSH address itself when it is already
 * an IP, else an explicitly-provided public IP, else null — at which point the
 * table shows a clearly-flagged placeholder with its copy button disabled
 * rather than a literal "your server's IP" string the user might paste.
 */
export function resolveServerIp(sshAddress: string, publicIp = ''): string | null {
	const ssh = sshAddress.trim();
	if (isIpv4(ssh)) return ssh;
	const ip = publicIp.trim();
	if (isIpv4(ip) || isIpv6(ip)) return ip;
	return null;
}

export interface DnsRecordRow {
	name: string;
	type: string;
	value: string;
	/** True when `value` is a placeholder (no real IP yet) — copy must be disabled. */
	placeholder?: boolean;
	/** Optional inline note (PTR reminder, deliverability follow-up). */
	note?: string;
}

export interface DnsRecordsInput {
	hosts: InstanceHostnames;
	/** Whether the self-hosted MTA is the sending provider (adds mail/bounce + SPF/DMARC). */
	withMta: boolean;
	/** The resolved server IP, or null to render a flagged placeholder. */
	serverIp: string | null;
}

/**
 * The DNS records implied by the chosen domain (+ MTA hostnames). For an MTA
 * install it also surfaces starter SPF + DMARC records so the user does not
 * believe the A/MX records alone make mail deliverable — DKIM is generated
 * in-app and the final values are confirmed in Settings → Domains.
 */
export function buildDnsRecords({ hosts, withMta, serverIp }: DnsRecordsInput): DnsRecordRow[] {
	const placeholder = serverIp === null;
	const target = serverIp ?? SERVER_IP_PLACEHOLDER;
	const rows: DnsRecordRow[] = [
		{ name: hosts.site, type: 'A', value: target, placeholder },
		{ name: hosts.convex, type: 'A', value: target, placeholder },
		{ name: hosts.convexSite, type: 'A', value: target, placeholder },
	];
	if (withMta) {
		rows.push(
			{ name: hosts.mail, type: 'A', value: target, placeholder, note: 'Also set reverse DNS (PTR) for this IP at your host.' },
			{ name: hosts.bounce, type: 'MX', value: hosts.mail },
			{ name: hosts.bounce, type: 'TXT', value: `v=spf1 a:${hosts.mail} -all`, note: 'SPF — starter value; confirm in Settings → Domains.' },
			{ name: `_dmarc.${hosts.bounce}`, type: 'TXT', value: 'v=DMARC1; p=none;', note: 'DMARC — starter value; tighten after monitoring.' },
		);
	}
	return rows;
}

// ---- post-run helpers ------------------------------------------------------

/**
 * Best-effort removal of the uploaded setup config after a successful install.
 * That file holds the admin password and every provider API key in plaintext,
 * so it must not linger on the server once quickstart has consumed it.
 */
export function removeSetupConfigCommand(installDir: string): string {
	return `rm -f '${setupConfigPath(installDir)}'`;
}

/**
 * The last `max` stderr lines from a streamed log — kept on failure so a long
 * build's root-cause error stays visible even after later output scrolls past.
 */
export function stderrTail(logs: ReadonlyArray<{ stream: 'stdout' | 'stderr'; line: string }>, max = 40): string[] {
	const out: string[] = [];
	for (let i = logs.length - 1; i >= 0 && out.length < max; i--) {
		const l = logs[i];
		if (l && l.stream === 'stderr') out.push(l.line);
	}
	return out.reverse();
}
