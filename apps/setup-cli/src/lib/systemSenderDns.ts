/**
 * The DNS records system mail still needs, as Convex stores them.
 *
 * The system sender's domain is registered as a sending domain
 * (`apps/api/convex/domains/systemSenderDomain.ts`), so its records are the
 * ones the Domains page lists. The installer's closing summary and `owlat
 * doctor` read them with `convex run` through the deploy image, the way the
 * support bundle reads the migration ledger, instead of deriving their own.
 */

import { isRecord } from '@owlat/shared';
import { runBounded } from './boundedCommand';
import type { DoctorFinding } from './doctorReport';
import { doctorText } from './doctorText';

/** The internal query that answers (apps/api/convex/domains/systemSenderDomain.ts). */
export const SYSTEM_SENDER_DNS_FUNCTION = 'domains/systemSenderDomain:dnsStatus';

/** `docker` arguments that run a Convex internal function through the deploy image. */
export function convexRunArgs(fn: string): string[] {
	return [
		'compose',
		'--profile',
		'deploy',
		'run',
		'--rm',
		'-T',
		'--no-deps',
		'convex-deploy',
		'convex',
		'run',
		fn,
	];
}

/** stdout of `convex run <fn>` in the install at `cwd`, or null when it did not run. */
export async function runConvexQuery(cwd: string, fn: string): Promise<string | null> {
	const result = await runBounded('docker', convexRunArgs(fn), {
		cwd,
		timeoutMs: 180_000,
		maxBytes: 1024 * 1024,
		keep: 'head',
	});
	return result.code === 0 && !result.truncated ? result.output : null;
}

export interface SystemSenderDnsRecord {
	label: string;
	type: string;
	name: string;
	value: string;
	/** null until the first DNS check has looked at it. */
	verified: boolean | null;
}

export type SystemSenderDnsStatus =
	| { state: 'not_configured' }
	| { state: 'not_registered'; domain: string }
	| {
			state: 'registering' | 'pending' | 'verified' | 'failed';
			domain: string;
			records: SystemSenderDnsRecord[];
			error?: string;
	  };

const REGISTERED_STATES = new Set(['registering', 'pending', 'verified', 'failed']);

function readRecord(value: unknown): SystemSenderDnsRecord | null {
	if (!isRecord(value)) return null;
	const { label, type, name, value: recordValue, verified } = value;
	if (
		typeof label !== 'string' ||
		typeof type !== 'string' ||
		typeof name !== 'string' ||
		typeof recordValue !== 'string' ||
		!(typeof verified === 'boolean' || verified === null)
	) {
		return null;
	}
	return { label, type, name, value: recordValue, verified };
}

/** The query's answer from `convex run` stdout, or null when it is not one. */
export function parseSystemSenderDnsStatus(stdout: string): SystemSenderDnsStatus | null {
	const text = stdout.trim();
	// The Convex CLI may print notices around the value; take the outermost object.
	const open = text.indexOf('{');
	const close = text.lastIndexOf('}');
	if (open === -1 || close <= open) return null;
	let value: unknown;
	try {
		value = JSON.parse(text.slice(open, close + 1));
	} catch {
		return null;
	}
	if (!isRecord(value) || typeof value['state'] !== 'string') return null;
	const state = value['state'];
	if (state === 'not_configured') return { state };
	const domain = value['domain'];
	if (typeof domain !== 'string') return null;
	if (state === 'not_registered') return { state, domain };
	if (!REGISTERED_STATES.has(state) || !Array.isArray(value['records'])) return null;
	const records = value['records'].map(readRecord);
	if (records.some((record) => record === null)) return null;
	return {
		state: state as 'registering' | 'pending' | 'verified' | 'failed',
		domain,
		records: records as SystemSenderDnsRecord[],
		...(typeof value['error'] === 'string' ? { error: value['error'] } : {}),
	};
}

/** The records the last DNS check did not find. */
function outstanding(records: readonly SystemSenderDnsRecord[]): SystemSenderDnsRecord[] {
	return records.filter((record) => record.verified !== true);
}

function recordLine(record: SystemSenderDnsRecord): string {
	return `  ${record.label}: ${record.type} ${record.name}  ${record.value}`;
}

/**
 * The installer's closing lines about system mail: what to publish, or why
 * there is nothing to show yet. Empty when there is nothing to say.
 */
export function systemSenderDnsLines(status: SystemSenderDnsStatus | null): string[] {
	if (!status || status.state === 'not_configured') return [];
	if (status.state === 'not_registered') {
		return [
			`System mail is sent from ${status.domain}, which is not a sending domain yet; add it on the Domains page so the MTA can DKIM-sign it.`,
		];
	}
	if (status.state === 'registering' || status.records.length === 0) {
		return [
			`System mail is sent from ${status.domain}. Its DKIM key is being generated; run \`owlat doctor\` for the DNS records to publish.`,
		];
	}
	if (status.state === 'failed' && status.error) {
		return [
			`System mail is sent from ${status.domain}, whose registration failed: ${status.error}`,
		];
	}
	const missing = outstanding(status.records);
	if (missing.length === 0) return [];
	return [
		`DNS records for system mail from ${status.domain} (also on the Domains page). Until they are published, receivers cannot verify its DKIM signature:`,
		...missing.map(recordLine),
	];
}

/** `owlat doctor`'s check of the system sender's domain; no finding when it cannot be read. */
export function systemSenderDnsFindings(status: SystemSenderDnsStatus | null): DoctorFinding[] {
	if (!status || status.state === 'not_configured') return [];
	const check = 'mta.system_sender_dns' as const;
	if (status.state === 'not_registered') {
		return [
			{
				check,
				ok: false,
				message: doctorText`System mail from ${status.domain} is not DKIM-signed: add ${status.domain} on the Domains page`,
			},
		];
	}
	if (status.state === 'registering' || status.records.length === 0) {
		return [
			{
				check,
				ok: false,
				message: doctorText`The DKIM key for system mail from ${status.domain} is still being generated; run doctor again`,
			},
		];
	}
	if (status.state === 'failed' && status.error) {
		return [
			{
				check,
				ok: false,
				message: doctorText`Registering ${status.domain} for system mail failed: ${status.error}`,
			},
		];
	}
	const missing = outstanding(status.records);
	if (missing.length === 0) {
		return [
			{
				check,
				ok: true,
				message: doctorText`DNS records for system mail from ${status.domain} are published`,
			},
		];
	}
	return missing.map((record) => ({
		check,
		subject: record.label,
		ok: false,
		message: doctorText`Publish for system mail from ${status.domain}: ${record.type} ${record.name} ${record.value}`,
	}));
}
