/**
 * Reverse-DNS (PTR) pre-flight for the installer.
 *
 * The MTA refuses to send from an address whose PTR does not forward-confirm to
 * the EHLO name it announces, and `quickstart` enforces exactly that right after
 * `docker compose up`. Nothing before that gate ever ASKED for the record: the
 * only mention was a parenthetical in the closing DNS summary, which a run that
 * dies on the gate never reaches — so the first an operator heard of PTR was the
 * install failing with `FCrDNS blocked for <ip>`. This module is the missing
 * half. It resolves the PTR the box actually carries, states the exact value it
 * must have, and names where to change it (the hosting provider's console, NOT
 * the DNS zone), BEFORE anything is brought up.
 *
 * The verdict comes from the same `verifyFcrdnsIdentity` the MTA and the web
 * wizard call, so the pre-flight and the gate can never disagree about what
 * "ready" means.
 */

import { reverse, resolve4, resolve6 } from 'node:dns/promises';
import { isCancel, log, select } from '@clack/prompts';
import {
	fcrdnsReasonMessage,
	isFqdn,
	parseGenericPtrSuffixes,
	reverseDnsGuidance,
	verifyFcrdnsIdentity,
	type FcrdnsDnsDeps,
} from '@owlat/shared/fcrdns';
import { normalizeDomain } from '@owlat/shared';
import { parseIpAddress } from '@owlat/shared/ipAddress';
import { parseCanonicalEhloHostnames } from '@owlat/shared/outboundIdentity';
import type { EnvMap } from './env';

/** One sending address and the name it will announce in EHLO. */
export interface OutboundIdentity {
	ip: string;
	ehlo: string;
	/** Forward record type the EHLO name needs for this address family. */
	recordType: 'A' | 'AAAA';
}

export interface ReverseDnsFinding extends OutboundIdentity {
	/** PTR names the resolver returns for `ip` right now; empty when none exist. */
	ptrNames: string[];
	/** True when the MTA's own identity gate would admit this address. */
	ready: boolean;
	/** Why it is not ready, in one sentence. Absent when ready. */
	problem?: string;
	/** Where the record is changed, inferred from the PTR the host handed out. */
	instruction: string;
}

function commaList(value: string | undefined): string[] {
	return (value ?? '')
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean);
}

const DEFAULT_DNS_DEPS: FcrdnsDnsDeps = { reverse, resolve4, resolve6 };

/**
 * The (ip, EHLO) pairs a `.env` would have the MTA send from — the same union of
 * both pools, and the same per-IP override precedence, the MTA resolves at boot.
 * Addresses that are not parseable and identities with no usable EHLO name are
 * dropped: they are a different (already reported) misconfiguration, and there
 * is no PTR value to ask for until a hostname exists.
 */
export function plannedOutboundIdentities(env: EnvMap): OutboundIdentity[] {
	const ips = [
		...new Set([
			...commaList(env['IP_POOLS_TRANSACTIONAL']),
			...commaList(env['IP_POOLS_CAMPAIGN']),
		]),
	];
	const defaultEhlo = normalizeDomain(env['EHLO_HOSTNAME'] ?? '');
	let perIp: Record<string, string> = {};
	try {
		perIp = parseCanonicalEhloHostnames(env['EHLO_HOSTNAMES']);
	} catch {
		// A malformed override map is the MTA's error to report at boot; fall back
		// to the default name so the operator still learns about the PTR record.
	}
	return ips.flatMap((raw) => {
		const parsed = parseIpAddress(raw);
		if (!parsed) return [];
		const ehlo = normalizeDomain(perIp[parsed.address] ?? defaultEhlo);
		if (!isFqdn(ehlo)) return [];
		return [
			{
				ip: parsed.address,
				ehlo,
				recordType: parsed.family === 'ipv6' ? ('AAAA' as const) : ('A' as const),
			},
		];
	});
}

/** Loopback and RFC 1918 space can never carry a public PTR. */
export function isPubliclyRoutable(ip: string): boolean {
	if (ip === '::1' || ip.startsWith('127.')) return false;
	if (ip.startsWith('10.') || ip.startsWith('192.168.')) return false;
	if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return false;
	if (ip.startsWith('169.254.') || ip.toLowerCase().startsWith('fe80:')) return false;
	// fc00::/7 — unique local addresses.
	return !/^f[cd]/i.test(ip);
}

/**
 * Resolve the live PTR for each identity. Never throws: a resolver failure reads
 * as "not ready yet", which is the actionable state anyway.
 */
export async function checkReverseDns(
	identities: readonly OutboundIdentity[],
	env: EnvMap = {},
	deps: FcrdnsDnsDeps = DEFAULT_DNS_DEPS
): Promise<ReverseDnsFinding[]> {
	let extraSuffixes: string[] = [];
	try {
		extraSuffixes = parseGenericPtrSuffixes(env['MTA_GENERIC_PTR_SUFFIXES']);
	} catch {
		// Same as above: the MTA validates this key at boot.
	}
	return await Promise.all(
		identities.map(async (identity) => {
			if (!isPubliclyRoutable(identity.ip)) {
				return {
					...identity,
					ptrNames: [],
					ready: false,
					problem: `${identity.ip} is not a public address, so it can never carry a PTR record. Set IP_POOLS_TRANSACTIONAL and IP_POOLS_CAMPAIGN to this server's public IP.`,
					instruction: reverseDnsGuidance([]).instruction,
				};
			}
			const result = await verifyFcrdnsIdentity(identity.ip, identity.ehlo, deps, extraSuffixes);
			const ready = result.verdict === 'pass' || result.verdict === 'warn';
			return {
				...identity,
				ptrNames: result.ptrNames,
				ready,
				...(ready ? {} : { problem: fcrdnsReasonMessage(result.reason) }),
				instruction: reverseDnsGuidance(result.ptrNames).instruction,
			};
		})
	);
}

/**
 * The operator-facing instruction block. Pure, so the exact wording is testable
 * and the same lines can go to a TTY, to the desktop installer's log drawer, or
 * into a doctor report.
 */
export function reverseDnsInstructions(findings: readonly ReverseDnsFinding[]): string[] {
	const blocked = findings.filter((finding) => !finding.ready);
	if (blocked.length === 0) return [];
	const lines = ['Reverse DNS (PTR) is not ready. This server cannot send mail until it is:'];
	for (const finding of blocked) {
		lines.push(
			`  ${finding.ip}  PTR  ${finding.ehlo}` +
				(finding.ptrNames.length
					? `   (today: ${finding.ptrNames.join(', ')})`
					: '   (no PTR record today)')
		);
		if (finding.problem) lines.push(`    ${finding.problem}`);
		lines.push(`    ${finding.instruction}`);
		lines.push(
			`    The name must point back: ${finding.ehlo}  ${finding.recordType}  ${finding.ip}`
		);
	}
	lines.push(
		'PTR lives with the host that owns the IP (your VPS provider), not in your DNS zone.',
		'Re-check any time with `owlat doctor`.'
	);
	return lines;
}

export interface AnnounceReverseDnsOptions {
	/** Offer a "set it now, re-check" loop. Off for CI and config-file installs. */
	interactive: boolean;
	/** Mirror every line into the progress stream (the desktop installer's drawer). */
	emit?: (line: string, stream?: 'stdout' | 'stderr') => void;
	deps?: FcrdnsDnsDeps;
}

/**
 * Tell the operator about the PTR record, and — on a TTY — let them go set it
 * and re-check without losing the install. Returns whether every identity is
 * ready; the caller decides whether that is fatal (it is not here: the MTA's own
 * gate is the authority, and an operator may legitimately continue while a
 * provider's reverse-DNS change propagates).
 */
export async function announceReverseDns(
	identities: readonly OutboundIdentity[],
	env: EnvMap,
	opts: AnnounceReverseDnsOptions
): Promise<boolean> {
	if (identities.length === 0) return true;
	for (;;) {
		const findings = await checkReverseDns(identities, env, opts.deps);
		if (findings.every((finding) => finding.ready)) {
			const line = `Reverse DNS is ready: ${findings
				.map((finding) => `${finding.ip} → ${finding.ehlo}`)
				.join(', ')}`;
			log.success(line);
			opts.emit?.(line);
			return true;
		}
		const lines = reverseDnsInstructions(findings);
		log.warn(lines[0]!);
		for (const line of lines.slice(1)) {
			log.message(line);
			opts.emit?.(line, 'stderr');
		}
		opts.emit?.(lines[0]!, 'stderr');
		if (!opts.interactive) return false;
		const choice = await select({
			message: 'Reverse DNS is not ready yet.',
			options: [
				{ label: 'I set the PTR record — check again', value: 'recheck' },
				{
					label: 'Continue anyway',
					value: 'continue',
					hint: 'the MTA will refuse to send until the PTR matches',
				},
			],
		});
		if (isCancel(choice) || choice === 'continue') return false;
	}
}
