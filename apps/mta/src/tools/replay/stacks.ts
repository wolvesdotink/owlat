/**
 * Corpus inputs and the in-house stack for the inbound shadow-replay harness
 * (piece C0).
 *
 * The permanent in-house stack ({@link owlatNewStack}) is the ONLY stack this
 * shipped tool imports directly (`parseMessage` + `verifyDkim`); the OLD (oracle)
 * stack is injected by the caller so mailparser / mailauth stay where I1 requires
 * them — differential oracles in test / operator code, never MTA runtime deps.
 */

import { parseMessage } from '@owlat/mail-message';
import { verifyDkim, type DkimDnsResolver } from '@owlat/mail-auth';
import { extractReportParts } from '../../bounce/reportParts.js';
import { projectDrivers, type RoutingDrivers } from './drivers.js';
import type { AuthVerdicts, DkimContext, SanctionedFields } from './diff.js';

/** DKIM DNS answers a corpus message carries so both stacks verify offline. */
export interface DkimCorpusHint {
	/** TXT records keyed by DNS name; absence for a queried name is NXDOMAIN. */
	readonly records?: Readonly<Record<string, readonly (readonly string[])[]>>;
}

/** SMTP-session metadata a corpus message carries (for SPF/DMARC, operator runs). */
export interface ReplayEnvelope {
	readonly clientIp?: string;
	readonly heloDomain?: string;
	readonly mailFrom?: string;
}

/** One raw message to replay, plus any sidecar metadata. */
export interface ReplayInput {
	readonly id: string;
	readonly raw: Buffer;
	readonly envelope?: ReplayEnvelope;
	readonly dkim?: DkimCorpusHint;
	/** Field paths whose divergence is a pre-signed sanctioned improvement (I2). */
	readonly sanctionedFields?: SanctionedFields;
}

/** One side of the differential — a parse projector and an optional auth step. */
export interface ReplayStackSide {
	project(raw: Buffer): RoutingDrivers | Promise<RoutingDrivers>;
	auth?(input: ReplayInput): AuthVerdicts | Promise<AuthVerdicts>;
}

/** The two stacks being compared: `old` (oracle) vs `new` (in-house). */
export interface ReplayStacks {
	readonly old: ReplayStackSide;
	readonly new: ReplayStackSide;
}

/** Build a DKIM TXT resolver from a corpus hint; unknown names are NXDOMAIN. */
export function resolverFromHint(hint: DkimCorpusHint | undefined): DkimDnsResolver {
	const records = hint?.records ?? {};
	return async (name: string, rrtype: 'TXT'): Promise<string[][]> => {
		const recs = rrtype === 'TXT' ? records[name] : undefined;
		if (recs !== undefined) return recs.map((chunks) => [...chunks]);
		const err = new Error(`ENOTFOUND ${name}`) as Error & { code: string };
		err.code = 'ENOTFOUND';
		throw err;
	};
}

/** Extract the folded `DKIM-Signature` header block from a raw message. */
function dkimSignatureBlock(raw: Buffer): string | undefined {
	const text = raw.toString('latin1');
	const headerEnd = text.search(/\r?\n\r?\n/);
	const headerText = headerEnd === -1 ? text : text.slice(0, headerEnd);
	const match = headerText.match(/^dkim-signature:[^\n]*(?:\n[ \t][^\n]*)*/im);
	return match ? match[0] : undefined;
}

/** Read a DKIM tag value (`l=`, `a=`) out of a signature header block. */
function dkimTag(block: string, tag: string): string | undefined {
	const re = new RegExp(`(?:^|;)\\s*${tag}\\s*=\\s*([^;\\r\\n]*)`, 'i');
	const m = block.replace(/\r?\n[ \t]/g, '').match(re);
	return m?.[1]?.trim();
}

/**
 * The permanent in-house stack: `parseMessage` for drivers, `verifyDkim` for
 * the DKIM verdict. This is the only stack this shipped tool imports directly;
 * the oracle (old) stack is injected by the caller (I1).
 *
 * The DKIM verdict is returned UNCONDITIONALLY (`none` for an unsigned message,
 * exactly as `verifyDkim` reports it) so the differential is symmetric — a
 * one-sided verdict, which `diffAuth` would silently skip, can never arise. The
 * `dkimContext` (l= / algorithm) is annotated only when a signature block is
 * present, since it justifies a sanctioned divergence.
 */
export const owlatNewStack = {
	project(raw: Buffer): RoutingDrivers {
		const parsed = parseMessage(raw);
		// The bounce/FBL pipeline consumes the SCRAPER SURFACE (`extractReportParts`),
		// not `parsed.attachments` — that is the whole point of the report-part
		// recovery (a disposition-less `message/delivery-status` is not a
		// `parseMessage` attachment). Project that surface so the differential
		// compares what the cutover pipeline actually reads against mailparser's
		// `attachments`.
		const attachments = extractReportParts(raw).map((p) => ({
			filename: p.filename ?? '',
			contentType: p.contentType,
			contentId: p.contentId,
			disposition: p.disposition,
			size: p.size,
			content: p.content,
		}));
		return projectDrivers({ ...parsed, attachments }, (name) => parsed.headers.get(name));
	},
	async auth(input: ReplayInput): Promise<AuthVerdicts> {
		const result = await verifyDkim(input.raw, { resolver: resolverFromHint(input.dkim) });
		const block = dkimSignatureBlock(input.raw);
		if (block === undefined) return { dkim: result.result };
		const lTag = dkimTag(block, 'l');
		const algorithm = dkimTag(block, 'a')?.toLowerCase();
		const context: DkimContext = {
			hadLTag: lTag !== undefined && lTag !== '',
			...(algorithm !== undefined ? { algorithm } : {}),
		};
		return { dkim: result.result, dkimContext: context };
	},
} satisfies ReplayStackSide;
