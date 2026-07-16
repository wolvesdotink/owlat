/**
 * Inbound shadow-replay harness (piece C0 of the 2026-07-16 "Own the Mail"
 * plan).
 *
 * The harness runs each raw `message/rfc822` blob through BOTH inbound stacks —
 * the OLD library stack (mailparser + mailauth) and the NEW in-house stack
 * (`@owlat/mail-message`'s `parseMessage` + `@owlat/mail-auth`'s `verifyDkim`)
 * — projects each onto the ROUTING / DELIVERY DRIVERS the six inbound consumers
 * actually read (parsed fields + DKIM/SPF/DMARC verdicts), and does a
 * FIELD-LEVEL diff. Any message whose drivers diverge is saved to a regression
 * corpus so the divergence can be replayed into the P3 (parse) and A2
 * (DKIM/canon) differential suites.
 *
 * DESIGN — WHY THE OLD STACK IS INJECTED, NOT IMPORTED HERE (I1 / I3):
 *   mailparser and mailauth survive ONLY as differential oracles and are being
 *   excised from the MTA's runtime deps by later pieces. So this shipped tool
 *   imports ONLY the permanent in-house packages for the NEW stack
 *   ({@link owlatNewStack}); the OLD (oracle) stack is passed in by the caller
 *   (the CI test wires it, an operator wires it for a real-mail run). That keeps
 *   the harness reusable AND keeps the oracle imports where I1 requires them.
 *
 * BODY SAFETY (I7 — the harness NEVER logs decoded bodies): the driver
 * projection reduces every body / attachment payload to a SHA-256 digest +
 * length BEFORE it enters a {@link RoutingDrivers} record, so no decoded body
 * text ever reaches a divergence record, the formatted report, or the JSON
 * divergence log. Only {@link saveDivergent} writes raw bytes, and it writes
 * them to the regression-corpus `.eml` (the message under test), never to a log.
 *
 * OPERATIONAL USE: point {@link loadCorpus} at a directory of sampled + scrubbed
 * real stored mail from a dev deployment (an operator step done pre-cutover),
 * wire the oracle stack, and feed {@link runReplay}'s report into
 * {@link saveDivergent}. The CI test runs the same engine over the small
 * checked-in slice only.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { parseMessage } from '@owlat/mail-message';
import { verifyDkim, type DkimDnsResolver } from '@owlat/mail-auth';

// ---------------------------------------------------------------------------
// Driver projection — the consumed-field contract, with bodies reduced to
// digests so no decoded body text ever enters a driver record.
// ---------------------------------------------------------------------------

/** One address entry the routing consumers read: display name + address. */
export interface DriverAddress {
	readonly name: string;
	readonly address: string;
}

/** An attachment projected onto its routing fields — payload is a digest only. */
export interface DriverAttachment {
	readonly filename: string;
	readonly contentType: string;
	readonly contentId: string;
	readonly disposition: string;
	readonly size: number;
	/** SHA-256 of the decoded payload — NEVER the payload itself (I7). */
	readonly contentSha256: string;
}

/** A body part reduced to a digest — the text is never retained (I7). */
export interface DriverBody {
	readonly present: boolean;
	readonly length: number;
	/** SHA-256 of the normalized body text, or `''` when absent. */
	readonly sha256: string;
}

/**
 * The routing / delivery drivers the six inbound consumers (mail-sync ingest,
 * the bounce parser / FBL processor / route resolver / attachment stager, and
 * the inbound forwarder) read off a parsed message. Two stacks must agree on
 * EVERY field here.
 */
export interface RoutingDrivers {
	readonly subject: string;
	readonly messageId: string;
	readonly inReplyTo: string;
	readonly references: readonly string[];
	readonly date: string;
	readonly from: readonly DriverAddress[];
	readonly to: readonly DriverAddress[];
	readonly cc: readonly DriverAddress[];
	readonly bcc: readonly DriverAddress[];
	readonly replyTo: readonly DriverAddress[];
	readonly text: DriverBody;
	readonly html: DriverBody;
	readonly attachments: readonly DriverAttachment[];
	readonly contentType: { readonly value: string; readonly reportType: string };
}

/** A structural address entry both stacks expose on `.value` (groups recurse). */
interface AddrEntryLike {
	readonly name?: string;
	readonly address?: string;
	readonly group?: readonly AddrEntryLike[];
}
interface AddrObjectLike {
	readonly value?: readonly AddrEntryLike[];
}

/** A structural attachment both stacks expose (mailparser + our parser). */
interface AttachmentLike {
	readonly filename?: string;
	readonly contentType?: string;
	readonly contentId?: string;
	readonly disposition?: string;
	readonly contentDisposition?: string;
	readonly size?: number;
	readonly content: Buffer | Uint8Array;
}

/** The subset of a parsed message the projection reads (mailparser ∩ ours). */
export interface ParsedLike {
	readonly subject?: string;
	readonly messageId?: string;
	readonly inReplyTo?: string;
	readonly references?: string | string[];
	readonly date?: Date;
	readonly from?: unknown;
	readonly to?: unknown;
	readonly cc?: unknown;
	readonly bcc?: unknown;
	readonly replyTo?: unknown;
	readonly text?: string;
	readonly html?: string | false;
	readonly attachments: readonly AttachmentLike[];
}

/** Header lookup used only for the structured `Content-Type` signal. */
export type HeaderLookup = (name: string) => unknown;

function sha256hex(input: Buffer | string): string {
	return createHash('sha256').update(input).digest('hex');
}

/** Flatten an address header (single/array, groups recursed) into an ordered list. */
function addrList(field: unknown): DriverAddress[] {
	if (field === undefined || field === null) return [];
	const objs = (Array.isArray(field) ? field : [field]) as AddrObjectLike[];
	const out: DriverAddress[] = [];
	const visit = (entries: readonly AddrEntryLike[] | undefined): void => {
		for (const entry of entries ?? []) {
			if (entry.group !== undefined) {
				visit(entry.group);
			} else {
				out.push({ name: entry.name ?? '', address: (entry.address ?? '').toLowerCase() });
			}
		}
	};
	for (const obj of objs) {
		if (obj && typeof obj === 'object') visit(obj.value);
	}
	return out;
}

/** Normalize the dual `references` / `in-reply-to` shape into an id list. */
function refsList(refs: string | string[] | undefined): string[] {
	if (refs === undefined) return [];
	const arr = Array.isArray(refs) ? refs : refs.split(/\s+/);
	return arr.map((r) => r.trim()).filter((r) => r !== '');
}

/** CRLF -> LF, drop trailing per-line and end whitespace (line-ending agnostic). */
function normBodyText(s: string): string {
	return s
		.replace(/\r\n/g, '\n')
		.replace(/[ \t]+$/gm, '')
		.replace(/\n+$/, '');
}

/** Reduce a body to a digest — the text is hashed, never retained (I7). */
function bodyDigest(s: string | false | undefined): DriverBody {
	if (s === false || s === undefined) return { present: false, length: 0, sha256: '' };
	const norm = normBodyText(s);
	return { present: true, length: norm.length, sha256: sha256hex(norm) };
}

/** The `Content-Type` signal the FBL / bounce classifiers consume: value + report-type. */
function contentTypeSignal(raw: unknown): { value: string; reportType: string } {
	if (raw && typeof raw === 'object') {
		const obj = raw as { value?: unknown; params?: Record<string, unknown> };
		const value = typeof obj.value === 'string' ? obj.value.toLowerCase() : '';
		const reportType = String(obj.params?.['report-type'] ?? '').toLowerCase();
		return { value, reportType };
	}
	if (typeof raw === 'string') return { value: raw.toLowerCase(), reportType: '' };
	return { value: '', reportType: '' };
}

/** Project the attachment set onto its routing fields — payloads become digests. */
function attList(attachments: readonly AttachmentLike[]): DriverAttachment[] {
	return attachments.map((a) => {
		const content = Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content);
		const disposition = a.disposition ?? a.contentDisposition ?? 'attachment';
		return {
			filename: a.filename ?? '',
			contentType: a.contentType ?? '',
			contentId: (a.contentId ?? '').replace(/[<>]/g, ''),
			disposition,
			size: a.size ?? content.length,
			contentSha256: sha256hex(content),
		};
	});
}

/**
 * Project a parsed message (from EITHER stack) onto the routing / delivery
 * drivers. Bodies and attachment payloads are reduced to SHA-256 digests, so a
 * {@link RoutingDrivers} value can be logged, diffed and serialized without ever
 * exposing decoded body text (I7).
 */
export function projectDrivers(parsed: ParsedLike, headerLookup: HeaderLookup): RoutingDrivers {
	return {
		subject: parsed.subject ?? '',
		messageId: parsed.messageId ?? '',
		inReplyTo: parsed.inReplyTo ?? '',
		references: refsList(parsed.references),
		date: parsed.date?.toISOString() ?? '',
		from: addrList(parsed.from),
		to: addrList(parsed.to),
		cc: addrList(parsed.cc),
		bcc: addrList(parsed.bcc),
		replyTo: addrList(parsed.replyTo),
		text: bodyDigest(parsed.text),
		html: bodyDigest(parsed.html),
		attachments: attList(parsed.attachments),
		contentType: contentTypeSignal(headerLookup('content-type')),
	};
}

// ---------------------------------------------------------------------------
// Auth verdicts.
// ---------------------------------------------------------------------------

/** Context that JUSTIFIES a sanctioned DKIM divergence (I2 (a)/(d)). */
export interface DkimContext {
	/** The message carried an `l=` body-length tag (drives the neutral cap). */
	readonly hadLTag?: boolean;
	/** The signature algorithm (`rsa-sha1` drives the policy-fail divergence). */
	readonly algorithm?: string;
}

/** The message-level auth verdicts a stack produces for a message + envelope. */
export interface AuthVerdicts {
	readonly dkim?: string;
	readonly spf?: string;
	readonly dmarc?: string;
	/** Only meaningful on the NEW stack — annotates why a DKIM divergence is sanctioned. */
	readonly dkimContext?: DkimContext;
}

// ---------------------------------------------------------------------------
// Divergences.
// ---------------------------------------------------------------------------

export type DivergenceCategory = 'parse-field' | 'dkim-verdict' | 'spf-verdict' | 'dmarc-verdict';

/**
 * The exact, enumerated set of sanctioned inbound behaviour changes (I2). Any
 * divergence NOT carrying one of these is an unsanctioned defect that fails the
 * replay gate.
 */
export type SanctionKind = 'dkim-l-neutral' | 'rsa-sha1-policy' | 'charset' | 'enhanced-code';

/** One field-level divergence between the old and new stacks for one message. */
export interface Divergence {
	readonly field: string;
	readonly category: DivergenceCategory;
	readonly oldValue: string;
	readonly newValue: string;
	readonly sanctioned: boolean;
	readonly sanction?: SanctionKind;
}

/** Field paths whose divergence is pre-signed as a sanctioned improvement (I2). */
export type SanctionedFields = Readonly<Record<string, SanctionKind>>;

/** Stable JSON of a driver field for a divergence record (never raw body text). */
function fieldValue(value: unknown): string {
	return JSON.stringify(value);
}

/** Diff two driver projections field by field; mark pre-signed sanctions. */
export function diffDrivers(
	oldD: RoutingDrivers,
	newD: RoutingDrivers,
	sanctioned: SanctionedFields = {}
): Divergence[] {
	const out: Divergence[] = [];
	const fields: readonly (keyof RoutingDrivers)[] = [
		'subject',
		'messageId',
		'inReplyTo',
		'references',
		'date',
		'from',
		'to',
		'cc',
		'bcc',
		'replyTo',
		'text',
		'html',
		'attachments',
		'contentType',
	];
	for (const field of fields) {
		const oldValue = fieldValue(oldD[field]);
		const newValue = fieldValue(newD[field]);
		if (oldValue === newValue) continue;
		const kind = sanctioned[field];
		out.push({
			field,
			category: 'parse-field',
			oldValue,
			newValue,
			sanctioned: kind !== undefined,
			...(kind !== undefined ? { sanction: kind } : {}),
		});
	}
	return out;
}

/**
 * Classify a DKIM verdict divergence. The ONLY sanctioned DKIM divergences
 * (I2) are: (a) `l=` present, old `pass` -> new `neutral` (append-attack cap),
 * and (d) `rsa-sha1`, old `pass` -> new `fail` (RFC 8301 policy). Everything
 * else is an unsanctioned defect.
 */
function classifyDkim(
	oldV: string,
	newV: string,
	ctx: DkimContext | undefined
): SanctionKind | undefined {
	if (oldV === 'pass' && newV === 'neutral' && ctx?.hadLTag === true) return 'dkim-l-neutral';
	if (oldV === 'pass' && newV === 'fail' && ctx?.algorithm === 'rsa-sha1') return 'rsa-sha1-policy';
	return undefined;
}

/** Diff two auth-verdict sets. SPF/DMARC divergences are never sanctioned here. */
export function diffAuth(oldA: AuthVerdicts, newA: AuthVerdicts): Divergence[] {
	const out: Divergence[] = [];

	if (oldA.dkim !== undefined && newA.dkim !== undefined && oldA.dkim !== newA.dkim) {
		const kind = classifyDkim(oldA.dkim, newA.dkim, newA.dkimContext);
		out.push({
			field: 'dkim',
			category: 'dkim-verdict',
			oldValue: oldA.dkim,
			newValue: newA.dkim,
			sanctioned: kind !== undefined,
			...(kind !== undefined ? { sanction: kind } : {}),
		});
	}

	const scalar: readonly { key: 'spf' | 'dmarc'; category: DivergenceCategory }[] = [
		{ key: 'spf', category: 'spf-verdict' },
		{ key: 'dmarc', category: 'dmarc-verdict' },
	];
	for (const { key, category } of scalar) {
		const oldV = oldA[key];
		const newV = newA[key];
		if (oldV !== undefined && newV !== undefined && oldV !== newV) {
			out.push({ field: key, category, oldValue: oldV, newValue: newV, sanctioned: false });
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Corpus inputs + stacks.
// ---------------------------------------------------------------------------

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
 */
export const owlatNewStack = {
	project(raw: Buffer): RoutingDrivers {
		const parsed = parseMessage(raw);
		return projectDrivers(parsed, (name) => parsed.headers.get(name));
	},
	async auth(input: ReplayInput): Promise<AuthVerdicts> {
		const block = dkimSignatureBlock(input.raw);
		if (block === undefined) return {};
		const result = await verifyDkim(input.raw, { resolver: resolverFromHint(input.dkim) });
		const lTag = dkimTag(block, 'l');
		const algorithm = dkimTag(block, 'a')?.toLowerCase();
		const context: DkimContext = {
			hadLTag: lTag !== undefined && lTag !== '',
			...(algorithm !== undefined ? { algorithm } : {}),
		};
		return { dkim: result.result, dkimContext: context };
	},
} satisfies ReplayStackSide;

// ---------------------------------------------------------------------------
// Replay.
// ---------------------------------------------------------------------------

/** Per-message replay outcome. */
export interface MessageReplayResult {
	readonly id: string;
	readonly divergences: readonly Divergence[];
	readonly hasUnsanctioned: boolean;
}

/** The categorized divergence report over a whole corpus. */
export interface ReplayReport {
	readonly results: readonly MessageReplayResult[];
	readonly totalMessages: number;
	readonly totalDivergences: number;
	readonly unsanctionedDivergences: number;
	readonly byCategory: Readonly<Record<DivergenceCategory, number>>;
	readonly sanctionedByKind: Readonly<Record<SanctionKind, number>>;
}

function emptyByCategory(): Record<DivergenceCategory, number> {
	return { 'parse-field': 0, 'dkim-verdict': 0, 'spf-verdict': 0, 'dmarc-verdict': 0 };
}

function emptyBySanction(): Record<SanctionKind, number> {
	return { 'dkim-l-neutral': 0, 'rsa-sha1-policy': 0, charset: 0, 'enhanced-code': 0 };
}

/**
 * Replay every input through both stacks and produce a categorized divergence
 * report. Divergences carry hashed bodies only, so the report is body-safe.
 */
export async function runReplay(
	inputs: readonly ReplayInput[],
	stacks: ReplayStacks
): Promise<ReplayReport> {
	const results: MessageReplayResult[] = [];
	const byCategory = emptyByCategory();
	const sanctionedByKind = emptyBySanction();
	let totalDivergences = 0;
	let unsanctionedDivergences = 0;

	for (const input of inputs) {
		const oldDrivers = await stacks.old.project(input.raw);
		const newDrivers = await stacks.new.project(input.raw);
		const divergences: Divergence[] = diffDrivers(oldDrivers, newDrivers, input.sanctionedFields);

		if (stacks.old.auth !== undefined && stacks.new.auth !== undefined) {
			const oldAuth = await stacks.old.auth(input);
			const newAuth = await stacks.new.auth(input);
			divergences.push(...diffAuth(oldAuth, newAuth));
		}

		let hasUnsanctioned = false;
		for (const d of divergences) {
			totalDivergences += 1;
			byCategory[d.category] += 1;
			if (d.sanctioned) {
				if (d.sanction !== undefined) sanctionedByKind[d.sanction] += 1;
			} else {
				unsanctionedDivergences += 1;
				hasUnsanctioned = true;
			}
		}
		results.push({ id: input.id, divergences, hasUnsanctioned });
	}

	return {
		results,
		totalMessages: inputs.length,
		totalDivergences,
		unsanctionedDivergences,
		byCategory,
		sanctionedByKind,
	};
}

// ---------------------------------------------------------------------------
// Corpus IO.
// ---------------------------------------------------------------------------

/** Raw shape of an optional `<stem>.json` sidecar next to a corpus `.eml`. */
interface CorpusSidecar {
	readonly envelope?: ReplayEnvelope;
	readonly dkim?: DkimCorpusHint;
	readonly sanctionedFields?: SanctionedFields;
}

/**
 * Load a corpus directory: every `*.eml` becomes a {@link ReplayInput}, with an
 * optional `<stem>.json` sidecar supplying envelope / DKIM DNS / sanctioned-field
 * metadata. An operator points this at sampled + scrubbed real stored mail; the
 * CI test points it at the checked-in slice.
 */
export function loadCorpus(dir: string): ReplayInput[] {
	const entries = readdirSync(dir)
		.filter((f) => extname(f).toLowerCase() === '.eml')
		.sort();
	const inputs: ReplayInput[] = [];
	for (const file of entries) {
		const id = basename(file, extname(file));
		const raw = readFileSync(join(dir, file));
		let sidecar: CorpusSidecar = {};
		try {
			sidecar = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')) as CorpusSidecar;
		} catch {
			sidecar = {}; // No sidecar — a plain message with no envelope / DKIM metadata.
		}
		inputs.push({
			id,
			raw,
			...(sidecar.envelope !== undefined ? { envelope: sidecar.envelope } : {}),
			...(sidecar.dkim !== undefined ? { dkim: sidecar.dkim } : {}),
			...(sidecar.sanctionedFields !== undefined
				? { sanctionedFields: sidecar.sanctionedFields }
				: {}),
		});
	}
	return inputs;
}

/**
 * Persist every DIVERGENT message to a regression corpus so the divergence can
 * be replayed into the P3 / A2 differential suites. The raw `.eml` is written
 * verbatim (it is the artifact under test — a regression fixture, not a log);
 * the companion `<id>.divergence.json` records ONLY field names + categories +
 * verdict / digest values, never decoded body text (I7). Returns the ids saved.
 */
export function saveDivergent(
	report: ReplayReport,
	inputs: readonly ReplayInput[],
	dir: string
): string[] {
	const byId = new Map(inputs.map((i) => [i.id, i]));
	mkdirSync(dir, { recursive: true });
	const saved: string[] = [];
	for (const result of report.results) {
		if (result.divergences.length === 0) continue;
		const input = byId.get(result.id);
		if (input === undefined) continue;
		writeFileSync(join(dir, `${result.id}.eml`), input.raw);
		writeFileSync(
			join(dir, `${result.id}.divergence.json`),
			`${JSON.stringify({ id: result.id, divergences: result.divergences }, null, 2)}\n`
		);
		saved.push(result.id);
	}
	return saved;
}

/**
 * Render a categorized, human-readable divergence report. Only field names,
 * categories, verdicts and body DIGESTS appear — never decoded body text (I7).
 */
export function formatReport(report: ReplayReport): string {
	const lines: string[] = [];
	lines.push('Inbound shadow-replay report');
	lines.push(`  messages:              ${report.totalMessages}`);
	lines.push(`  divergences:           ${report.totalDivergences}`);
	lines.push(`  unsanctioned:          ${report.unsanctionedDivergences}`);
	lines.push('  by category:');
	for (const [category, count] of Object.entries(report.byCategory)) {
		lines.push(`    ${category}: ${count}`);
	}
	lines.push('  sanctioned by kind:');
	for (const [kind, count] of Object.entries(report.sanctionedByKind)) {
		lines.push(`    ${kind}: ${count}`);
	}
	for (const result of report.results) {
		if (result.divergences.length === 0) continue;
		lines.push(`  message ${result.id}${result.hasUnsanctioned ? ' (UNSANCTIONED)' : ''}:`);
		for (const d of result.divergences) {
			const tag = d.sanctioned ? `sanctioned:${d.sanction}` : 'UNSANCTIONED';
			lines.push(`    [${d.category}] ${d.field}: ${d.oldValue} -> ${d.newValue} (${tag})`);
		}
	}
	return lines.join('\n');
}
