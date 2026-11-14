'use node';

/**
 * Whether mail can flow back: the From domain accepts mail (`domain.from_mx`)
 * and bounces reach the built-in mail server (`domain.bounce_mx`).
 *
 * A resolver that does not answer (SERVFAIL, timeout, refused) is no evidence
 * either way, so it yields `warn` and never `fail`, the same rule the domain
 * lifecycle follows (`domains/lifecycleVerdict.ts`). Only NXDOMAIN and NODATA
 * say a record is absent; absence takes the checklist's DNS retry chain
 * (`pending-dns`, then `fail` on the final retry).
 */

import dns from 'node:dns/promises';
import { getOptional } from '../lib/env';
import { returnPathProviderFor } from '../domains/returnPathProviders';
import { OWN_SENDING_DOMAIN_PROVIDER_KIND } from '../domains/providers';
import {
	checklistObservation,
	pendingDnsStatus,
	type ChecklistObservation,
	type ChecklistVerificationContext,
} from './checklistValidatorTypes';

type Lookup<T> = { kind: 'found'; values: T[] } | { kind: 'absent' } | { kind: 'unanswered' };

const ABSENT_CODES = new Set(['ENOTFOUND', 'ENODATA']);

async function lookup<T>(query: () => Promise<T[]>): Promise<Lookup<T>> {
	try {
		const values = await query();
		return values.length > 0 ? { kind: 'found', values } : { kind: 'absent' };
	} catch (error) {
		const code = (error as { code?: unknown }).code;
		return typeof code === 'string' && ABSENT_CODES.has(code)
			? { kind: 'absent' }
			: { kind: 'unanswered' };
	}
}

function hostName(value: string): string {
	return value.trim().toLowerCase().replace(/\.$/, '');
}

async function addresses(host: string): Promise<Lookup<string>> {
	const [v4, v6] = await Promise.all([
		lookup(() => dns.resolve4(host)),
		lookup(() => dns.resolve6(host)),
	]);
	const found = [
		...(v4.kind === 'found' ? v4.values : []),
		...(v6.kind === 'found' ? v6.values : []),
	];
	if (found.length > 0) return { kind: 'found', values: found };
	return v4.kind === 'unanswered' || v6.kind === 'unanswered'
		? { kind: 'unanswered' }
		: { kind: 'absent' };
}

/** RFC 7505: a single MX with an empty exchange says the domain accepts no mail. */
function isNullMx(records: readonly { exchange: string }[]): boolean {
	return records.length === 1 && hostName(records[0]!.exchange) === '';
}

export async function observeFromDomainAcceptsMail(
	context: ChecklistVerificationContext,
	providerValues: string[],
	isFinalDnsRetry: boolean
): Promise<ChecklistObservation> {
	const domain = context.domain!.domain;
	const unanswered = () =>
		checklistObservation(
			'dns.from-mx',
			'warn',
			`The resolver did not answer for ${domain}, so Owlat could not tell whether it accepts mail. It checks again on the next sweep.`,
			[...providerValues, 'lookup=unanswered']
		);
	const mx = await lookup(() => dns.resolveMx(domain));
	if (mx.kind === 'unanswered') return unanswered();
	if (mx.kind === 'found') {
		if (isNullMx(mx.values)) {
			return checklistObservation(
				'dns.from-mx',
				'fail',
				`${domain} publishes a Null MX, which tells receivers it accepts no mail. Mail sent from it is commonly refused.`,
				[...providerValues, 'mx=null']
			);
		}
		return checklistObservation(
			'dns.from-mx',
			'pass',
			`${domain} has an MX record, so replies and bounces can reach it.`,
			[...providerValues, ...mx.values.map((record) => `mx=${hostName(record.exchange)}`)]
		);
	}
	const fallback = await addresses(domain);
	if (fallback.kind === 'unanswered') return unanswered();
	if (fallback.kind === 'found') {
		return checklistObservation(
			'dns.from-mx',
			'pass',
			`${domain} has no MX record, but its address record serves as one.`,
			[...providerValues, ...fallback.values.map((address) => `address=${address}`)]
		);
	}
	return checklistObservation(
		'dns.from-mx',
		pendingDnsStatus(isFinalDnsRetry),
		`${domain} has no MX and no address record, so it cannot receive replies or bounces.`,
		[...providerValues, 'mx=absent', 'address=absent']
	);
}

export async function observeBouncesReachMailServer(
	context: ChecklistVerificationContext,
	providerValues: string[],
	isFinalDnsRetry: boolean
): Promise<ChecklistObservation> {
	const domain = context.domain!;
	if (domain.providerType !== OWN_SENDING_DOMAIN_PROVIDER_KIND) {
		return checklistObservation(
			'dns.bounce-mx',
			'pass',
			'This domain sends through a provider that receives its bounces, not through the built-in mail server.',
			providerValues
		);
	}
	const host = returnPathProviderFor(domain.providerType)?.activeHost(
		domain.domain,
		domain.returnPathHost?.toLowerCase().replace(/\.$/, '')
	);
	const mailHost = hostName(getOptional('EHLO_HOSTNAME') ?? '');
	if (!host || !mailHost) {
		return checklistObservation(
			'dns.bounce-mx',
			'warn',
			!host
				? 'Owlat does not know the return-path host. Set MTA_RETURN_PATH_DOMAIN to the same value as the mail server.'
				: 'Owlat does not know the mail server hostname. Set EHLO_HOSTNAME so the bounce MX can be checked.',
			providerValues
		);
	}
	const observed = [...providerValues, `return-path=${host}`, `mail-host=${mailHost}`];
	const mx = await lookup(() => dns.resolveMx(host));
	if (mx.kind === 'unanswered') {
		return checklistObservation(
			'dns.bounce-mx',
			'warn',
			`The resolver did not answer for ${host}. Owlat checks again on the next sweep.`,
			[...observed, 'lookup=unanswered']
		);
	}
	const exchanges = mx.kind === 'found' ? mx.values.map((record) => hostName(record.exchange)) : [];
	let pass = exchanges.includes(mailHost);
	if (!pass && exchanges.length > 0) {
		// An MX may name another hostname of the same server.
		const answers = await Promise.all([mailHost, ...exchanges].map((name) => addresses(name)));
		const [mailAddresses, ...exchangeAddresses] = answers;
		const ours = new Set(mailAddresses?.kind === 'found' ? mailAddresses.values : []);
		pass = exchangeAddresses.some(
			(answer) => answer.kind === 'found' && answer.values.some((address) => ours.has(address))
		);
		if (!pass && answers.some((answer) => answer.kind === 'unanswered')) {
			return checklistObservation(
				'dns.bounce-mx',
				'warn',
				`The MX of ${host} names ${exchanges.join(', ')}, and the resolver did not answer whether that is ${mailHost}. Owlat checks again on the next sweep.`,
				[...observed, ...exchanges.map((name) => `mx=${name}`), 'lookup=unanswered']
			);
		}
	}
	return checklistObservation(
		'dns.bounce-mx',
		pass ? 'pass' : pendingDnsStatus(isFinalDnsRetry),
		pass
			? `${host} has an MX record that points at ${mailHost}, so bounces reach this server.`
			: exchanges.length > 0
				? `The MX of ${host} points at ${exchanges.join(', ')}, not at ${mailHost}. Bounces do not reach this server.`
				: `${host} has no MX record, so bounces cannot reach this server.`,
		[...observed, ...(exchanges.length > 0 ? exchanges.map((name) => `mx=${name}`) : ['mx=absent'])]
	);
}
