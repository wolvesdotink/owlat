'use node';

/**
 * DMARC aggregate reports — unpack, parse and enrich, in the Node runtime.
 *
 * `decodeAndIngest` takes the attachment the webhook (`dmarcReportsHttp.ts`)
 * found, works out by its bytes whether it is gzip, zip or plain XML, inflates
 * it with `node:zlib` under a hard output cap (zip bombs stop at the cap, not
 * at the sender's declared size), parses it with the never-throwing shared
 * parser and stores it through `dmarcReports.ingest`.
 *
 * `resolveSourceHosts` runs after a report is stored: each distinct source IP
 * gets a reverse DNS lookup, and the name is kept only when it resolves back to
 * the same IP (forward-confirmed), so a sender cannot label itself `google.com`
 * by setting its own PTR record.
 *
 * Internal-only: reachable from the authenticated webhook and the ingest
 * mutation's scheduler.
 */

import dns from 'node:dns/promises';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { v } from 'convex/values';
import { internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import {
	DMARC_REPORT_MAX_COMPRESSED_BYTES,
	DMARC_REPORT_MAX_XML_BYTES,
	locateZipXmlEntry,
	parseDmarcReport,
	sniffDmarcReportContainer,
} from '@owlat/shared/dmarcReport';
import { normalizeIpAddress } from '@owlat/shared/ipAddress';

const LOOKUP_TIMEOUT_MS = 2_000;
const LOOKUP_CONCURRENCY = 8;

type Decoded = { ok: true; xml: string } | { ok: false; reason: string };

/** Inflate with an output cap; a payload that would exceed it is refused. */
function inflateCapped(inflate: () => Buffer): Decoded {
	try {
		return { ok: true, xml: inflate().toString('utf8') };
	} catch (error) {
		if (error instanceof RangeError) return { ok: false, reason: 'report-too-large' };
		return { ok: false, reason: 'corrupt-archive' };
	}
}

/** Turn an attachment's bytes into report XML. Never throws. */
export function decodeDmarcAttachment(bytes: Uint8Array): Decoded {
	const options = { maxOutputLength: DMARC_REPORT_MAX_XML_BYTES };
	switch (sniffDmarcReportContainer(bytes)) {
		case 'gzip':
			if (bytes.byteLength > DMARC_REPORT_MAX_COMPRESSED_BYTES) {
				return { ok: false, reason: 'payload-too-large' };
			}
			return inflateCapped(() => gunzipSync(bytes, options));
		case 'zip': {
			if (bytes.byteLength > DMARC_REPORT_MAX_COMPRESSED_BYTES) {
				return { ok: false, reason: 'payload-too-large' };
			}
			const located = locateZipXmlEntry(bytes);
			if (!located.ok) return { ok: false, reason: located.error };
			const { entry } = located;
			if (entry.method === 0) {
				return { ok: true, xml: Buffer.from(entry.data).toString('utf8') };
			}
			return inflateCapped(() => inflateRawSync(entry.data, options));
		}
		case 'xml':
			if (bytes.byteLength > DMARC_REPORT_MAX_XML_BYTES) {
				return { ok: false, reason: 'report-too-large' };
			}
			return { ok: true, xml: Buffer.from(bytes).toString('utf8') };
		case 'unknown':
			return { ok: false, reason: 'not-a-report' };
	}
}

/**
 * Decode one forwarded attachment and, when it is a valid report, ingest it.
 * Never throws for a bad report: every failure is `{ ok: false, reason }` so
 * the webhook acknowledges it and the MTA stops retrying.
 */
export const decodeAndIngest = internalAction({
	args: { contentBase64: v.string() },
	returns: v.object({ ok: v.boolean(), reason: v.optional(v.string()) }),
	handler: async (ctx, args): Promise<{ ok: boolean; reason?: string }> => {
		const maxBase64 = 4 * Math.ceil(DMARC_REPORT_MAX_XML_BYTES / 3);
		if (args.contentBase64.length > maxBase64) return { ok: false, reason: 'payload-too-large' };
		const bytes = new Uint8Array(Buffer.from(args.contentBase64, 'base64'));
		if (bytes.byteLength === 0) return { ok: false, reason: 'empty-attachment' };

		const decoded = decodeDmarcAttachment(bytes);
		if (!decoded.ok) return decoded;
		const parsed = parseDmarcReport(decoded.xml);
		if (!parsed.ok) return { ok: false, reason: parsed.error };

		const { records, ...report } = parsed.report;
		const result = await ctx.runMutation(internal.domains.dmarcReports.ingest, {
			report,
			records,
		});
		return result.status === 'stored' ? { ok: true } : { ok: false, reason: result.status };
	},
});

function withTimeout<T>(promise: Promise<T>): Promise<T | null> {
	return Promise.race([
		promise.catch(() => null),
		new Promise<null>((resolve) => setTimeout(() => resolve(null), LOOKUP_TIMEOUT_MS)),
	]);
}

/** The forward-confirmed reverse DNS name of `ip`, or null. */
async function confirmedHostName(ip: string): Promise<string | null> {
	const names = await withTimeout(dns.reverse(ip));
	const name = names?.[0]?.toLowerCase().replace(/\.$/, '');
	if (!name) return null;
	const resolveForward = ip.includes(':') ? dns.resolve6(name) : dns.resolve4(name);
	const addresses = await withTimeout(resolveForward);
	const normalized = normalizeIpAddress(ip);
	return addresses?.some((address) => normalizeIpAddress(address) === normalized) ? name : null;
}

/** Name the source IPs of a freshly stored report (best effort, bounded). */
export const resolveSourceHosts = internalAction({
	args: { reportDocId: v.id('dmarcReports') },
	returns: v.null(),
	handler: async (ctx, { reportDocId }) => {
		const ips: string[] = await ctx.runQuery(internal.domains.dmarcReports.listUnresolvedSources, {
			reportDocId,
		});
		const hosts: Array<{ ip: string; host: string }> = [];
		for (let i = 0; i < ips.length; i += LOOKUP_CONCURRENCY) {
			const batch = ips.slice(i, i + LOOKUP_CONCURRENCY);
			const names = await Promise.all(batch.map((ip) => confirmedHostName(ip)));
			for (const [index, ip] of batch.entries()) {
				const host = names[index];
				if (host) hosts.push({ ip, host });
			}
		}
		if (hosts.length > 0) {
			await ctx.runMutation(internal.domains.dmarcReports.recordSourceHosts, {
				reportDocId,
				hosts,
			});
		}
		return null;
	},
});
