/**
 * Inbound shadow-replay harness — CI slice (piece C0).
 *
 * Runs the checked-in, non-sensitive corpus through BOTH inbound stacks — the
 * OLD oracle stack (mailparser `simpleParser` for the drivers + the pinned
 * `mailauth`-backed `verifyDkim` oracle from `bounce/__tests__/helpers/inboundDkimOracle` for the DKIM
 * verdict) and the NEW in-house stack ({@link owlatNewStack}: `parseMessage` +
 * `@owlat/mail-auth`'s `verifyDkim`) — and asserts a field-level diff of the
 * routing / delivery drivers with a categorized divergence report and ZERO
 * unsanctioned divergence (the only sanctioned inbound changes are the
 * enumerated l= / charset improvements; I2).
 *
 * The old side wires the pinned `mailauth` oracle, never a re-implemented copy
 * of its verdict normalization: `inboundDkimOracle.verifyDkim` normalizes
 * `mailauth`'s own per-signature output and accepts an injected resolver, so the
 * differential compares the library-normalized verdict against the in-house one
 * (a private copy could drift and mask divergence in exactly the normalization
 * layer being replaced). Production has cut over to `@owlat/mail-auth` (CI3);
 * mailparser / mailauth survive only as differential oracles (I1) and are wired
 * HERE, never imported by the shipped tool.
 *
 * The final block pins the load-bearing I7 invariant — the harness NEVER writes
 * decoded body text to a log or report — by seeding a corpus message with a
 * unique body marker and asserting it appears in NO driver record, NO formatted
 * report, and NO divergence JSON (only in the raw `.eml` regression artifact).
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync } from 'node:crypto';
import { dkimSign } from 'mailauth/lib/dkim/sign.js';
import {
	diffAuth,
	diffDrivers,
	formatReport,
	loadCorpus,
	owlatNewStack,
	runReplay,
	saveDivergent,
	type AuthVerdicts,
	type ReplayInput,
	type ReplayStackSide,
	type RoutingDrivers,
} from '../inboundReplay';
import { oracleOldStack } from './helpers/oracleStack';
// The bounce/FBL scrapers are driven directly (below) to prove the report-part
// recovery yields IDENTICAL classification outcomes across the library boundary.
// Only logging is stubbed; mailparser stays the oracle (I1), while attribution
// uses the same signed VERP proof required in production.
vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
import { simpleParser } from 'mailparser';
import { parseMessage, type ParsedMessage } from '@owlat/mail-message';
import { extractReportParts, type ReportPart } from '../../bounce/reportParts.js';
import { parseBounce } from '../../bounce/parser.js';
import { buildVerpAddress } from '../../bounce/verp.js';
import { tryParseARF } from '../../bounce/fblProcessor.js';
import type { BounceClassification } from '../../bounce/types.js';

const CORPUS_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'__fixtures__',
	'replay-corpus'
);

const BODY_MARKER = 'SECRETBODYMARKER7f3a';

describe('inbound shadow-replay over the checked-in corpus slice', () => {
	it('loads every .eml in the slice', () => {
		const inputs = loadCorpus(CORPUS_DIR);
		expect(inputs.length).toBeGreaterThanOrEqual(6);
		const ids = new Set(inputs.map((i) => i.id));
		expect(ids.size).toBe(inputs.length);
	});

	it('old vs new agree on every routing/delivery driver (zero unsanctioned divergence)', async () => {
		const inputs = loadCorpus(CORPUS_DIR);
		const report = await runReplay(inputs, { old: oracleOldStack, new: owlatNewStack });

		// Categorized report over the full slice: NO unsanctioned divergence.
		expect(report.totalMessages).toBe(inputs.length);
		expect(report.unsanctionedDivergences).toBe(0);
		expect(report.results.every((r) => !r.hasUnsanctioned)).toBe(true);
		expect(report.byCategory['dkim-verdict']).toBe(0);

		// The ONLY divergence in the slice is the enumerated report-part-recovery
		// (I2 #1) on the disposition-less DSN: mailparser folds a disposition-less
		// `message/delivery-status` into `.text` and drops it from `attachments`,
		// while `parseMessage` + `extractReportParts` keep it a distinct report part.
		// Both driver fields (`text`, `attachments`) therefore differ and are
		// pre-signed via the `dsn-report-nodisp.json` sidecar; every other message is
		// byte-identical. (The disposition-less ARF surfaces `message/feedback-report`
		// as an attachment on BOTH stacks, so it does not diverge.)
		expect(report.sanctionedByKind['report-part-recovery']).toBe(2);
		expect(report.totalDivergences).toBe(2);
		expect(report.byCategory['parse-field']).toBe(2);
		const dsnNodisp = report.results.find((r) => r.id === 'dsn-report-nodisp');
		expect(dsnNodisp?.divergences.map((d) => d.field).sort()).toEqual(['attachments', 'text']);
		expect(dsnNodisp?.divergences.every((d) => d.sanction === 'report-part-recovery')).toBe(true);
	});

	it('the genuine DSN exercises the delivery-status + returned-message drivers', () => {
		const raw = readFileSync(join(CORPUS_DIR, 'dsn-report.eml'));
		const drivers = owlatNewStack.project(raw);
		// The bounce classifier reads the multipart/report + report-type signal …
		expect(drivers.contentType.value).toBe('multipart/report');
		expect(drivers.contentType.reportType).toBe('delivery-status');
		// … and the DSN driver is the delivery-status part plus the returned message.
		const cts = drivers.attachments.map((a) => a.contentType);
		expect(cts).toContain('message/delivery-status');
		expect(cts).toContain('message/rfc822');
	});

	it('actually compares bodies (digests are non-empty, not skipped)', () => {
		const raw = readFileSync(join(CORPUS_DIR, 'plain-text.eml'));
		const drivers = owlatNewStack.project(raw);
		expect(drivers.text.present).toBe(true);
		expect(drivers.text.sha256).toMatch(/^[0-9a-f]{64}$/);
	});
});

// Gate (b) proper: the report-part recovery is behavior-preserving where it
// MATTERS — the bounce class and the FBL complaint outcome. The raw parse
// representation diverges (mailparser folds a disposition-less
// `message/delivery-status` into `.text`; `parseMessage` keeps it a report part),
// which is the sanctioned `report-part-recovery` divergence above. Here we drive
// the ACTUAL scrapers off each stack's surface and assert the classification is
// identical across the library boundary — the outcome that ships.
describe('report-part recovery keeps bounce-class / FBL outcomes identical', () => {
	/** The scraper report-parts as mailparser surfaced them (attachments). */
	function oldReportParts(
		atts: readonly { contentType?: string; content?: Buffer }[]
	): ReportPart[] {
		return atts.map((a) => ({
			contentType: (a.contentType ?? '').toLowerCase(),
			content: a.content ?? Buffer.alloc(0),
		}));
	}

	it('the disposition-less DSN classifies the SAME hard bounce on old (mailparser) and new stacks', async () => {
		const verpKey = 'replay-corpus-verp-key-012345678901';
		process.env['BOUNCE_VERP_KEY'] = verpKey;
		const envelopeRecipient = buildVerpAddress('corpus-message', 'bounces.test', verpKey);
		const raw = readFileSync(join(CORPUS_DIR, 'dsn-report-nodisp.eml'));

		const newParsed = parseMessage(raw);
		const newResult = parseBounce(newParsed, extractReportParts(raw), envelopeRecipient);

		const oldParsed = (await simpleParser(raw)) as unknown as ParsedMessage;
		const oldAtts = (await simpleParser(raw)).attachments;
		const oldResult = parseBounce(oldParsed, oldReportParts(oldAtts), envelopeRecipient);

		// The new stack recovered the machine-readable delivery-status the pipeline
		// classifies off — mailparser had it folded into `.text` instead.
		expect(extractReportParts(raw).map((p) => p.contentType)).toContain('message/delivery-status');

		// Identical outcome across the library boundary: both hard-bounce 5.1.1.
		const norm = (r: BounceClassification | null) => ({ type: r?.type, bounceType: r?.bounceType });
		expect(newResult?.bounceType).toBe('hard');
		expect(norm(newResult)).toEqual(norm(oldResult));
		expect(newResult?.originalMessageId).toBe(oldResult?.originalMessageId);
		delete process.env['BOUNCE_VERP_KEY'];
	});

	it('the disposition-less ARF yields the SAME complaint on old (mailparser) and new stacks', async () => {
		const raw = readFileSync(join(CORPUS_DIR, 'arf-report-nodisp.eml'));

		const newParsed = parseMessage(raw);
		const newResult = tryParseARF(newParsed, extractReportParts(raw));

		const oldParsed = (await simpleParser(raw)) as unknown as ParsedMessage;
		const oldAtts = (await simpleParser(raw)).attachments;
		const oldResult = tryParseARF(oldParsed, oldReportParts(oldAtts));

		expect(newResult?.type).toBe('complained');
		expect(newResult?.bounceType).toBe('hard');
		expect(oldResult?.type).toBe('complained');
		expect(oldResult?.bounceType).toBe('hard');
	});
});

describe('DKIM verdicts flow through the harness (feeds the A2 differential suite)', () => {
	const DOMAIN = 'example.com';
	const SELECTOR = 'sel';
	const KEY_NAME = `${SELECTOR}._domainkey.${DOMAIN}`;
	const RAW_MESSAGE = [
		'From: Alice <alice@example.com>',
		'To: Bob <bob@example.org>',
		'Subject: DKIM replay fixture',
		'Date: Tue, 17 Jun 2026 12:00:00 +0000',
		'Message-ID: <dkim-replay-1@example.com>',
		'MIME-Version: 1.0',
		'Content-Type: text/plain; charset=utf-8',
		'',
		'A DKIM-signed body replayed through both stacks.',
		'',
	].join('\r\n');

	function pemToBase64(pem: string): string {
		return pem
			.replace(/-----BEGIN PUBLIC KEY-----/, '')
			.replace(/-----END PUBLIC KEY-----/, '')
			.replace(/\s+/g, '');
	}

	it('a valid rsa-sha256 signature verifies pass on BOTH stacks, with dkimContext annotated', async () => {
		const rsa = generateKeyPairSync('rsa', {
			modulusLength: 2048,
			publicKeyEncoding: { type: 'spki', format: 'pem' },
			privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
		});
		const txt = `v=DKIM1; k=rsa; p=${pemToBase64(rsa.publicKey)}`;
		const signed = await dkimSign(Buffer.from(RAW_MESSAGE), {
			canonicalization: 'relaxed/relaxed',
			algorithm: 'rsa-sha256',
			signatureData: [{ signingDomain: DOMAIN, selector: SELECTOR, privateKey: rsa.privateKey }],
		});
		const raw = Buffer.from((signed as { signatures: string }).signatures + RAW_MESSAGE);
		const input: ReplayInput = {
			id: 'dkim-pass',
			raw,
			dkim: { records: { [KEY_NAME]: [[txt]] } },
		};

		// Both stacks reach pass on their own …
		const newAuthFn = owlatNewStack.auth;
		const oldAuthFn = oracleOldStack.auth;
		if (newAuthFn === undefined || oldAuthFn === undefined) throw new Error('auth step missing');
		const newAuth = await newAuthFn(input);
		const oldAuth = await oldAuthFn(input);
		expect(newAuth.dkim).toBe('pass');
		expect(oldAuth.dkim).toBe('pass');

		// … and the new stack extracts the DKIM context out of the raw bytes
		// (algorithm + the absence of an l= tag) that JUSTIFIES a sanctioned
		// divergence — the plumbing the l= corpus case below relies on end-to-end.
		expect(newAuth.dkimContext?.algorithm).toBe('rsa-sha256');
		expect(newAuth.dkimContext?.hadLTag).toBe(false);

		// … so the harness records no divergence for the signed message.
		const report = await runReplay([input], { old: oracleOldStack, new: owlatNewStack });
		expect(report.unsanctionedDivergences).toBe(0);
		expect(report.byCategory['dkim-verdict']).toBe(0);
	});

	it('an l=-signed message diverges pass -> neutral (SANCTIONED) through loadCorpus + a DKIM sidecar', async () => {
		const rsa = generateKeyPairSync('rsa', {
			modulusLength: 2048,
			publicKeyEncoding: { type: 'spki', format: 'pem' },
			privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
		});
		const txt = `v=DKIM1; k=rsa; p=${pemToBase64(rsa.publicKey)}`;
		const body = 'Body fully covered by an l= tag.\r\n';
		const lMessage = [
			'From: Alice <alice@example.com>',
			'To: Bob <bob@example.org>',
			'Subject: l-tag replay fixture',
			'Date: Tue, 17 Jun 2026 12:00:00 +0000',
			'Message-ID: <ltag-replay-1@example.com>',
			'MIME-Version: 1.0',
			'Content-Type: text/plain; charset=utf-8',
			'',
			body,
		].join('\r\n');
		// `maxBodyLength` makes mailauth emit an l= tag over the WHOLE body: the old
		// stack authenticates it (pass), the new stack caps l= at neutral (I2 a).
		const signed = await dkimSign(Buffer.from(lMessage), {
			canonicalization: 'relaxed/relaxed',
			algorithm: 'rsa-sha256',
			signatureData: [
				{
					signingDomain: DOMAIN,
					selector: SELECTOR,
					privateKey: rsa.privateKey,
					maxBodyLength: body.length,
				},
			],
		});
		const raw = Buffer.from((signed as { signatures: string }).signatures + lMessage);

		// Drive it through the FULL corpus path: a real directory with an .eml plus
		// a `.json` DKIM sidecar, loaded by loadCorpus (exercising the sidecar
		// branch), then replayed through both stacks.
		const dir = mkdtempSync(join(tmpdir(), 'replay-ltag-'));
		try {
			writeFileSync(join(dir, 'ltag.eml'), raw);
			writeFileSync(
				join(dir, 'ltag.json'),
				JSON.stringify({ dkim: { records: { [KEY_NAME]: [[txt]] } } })
			);
			const inputs = loadCorpus(dir);
			expect(inputs).toHaveLength(1);
			// The sidecar branch actually ran: the DKIM DNS hint reached the input.
			expect(inputs[0]?.dkim?.records?.[KEY_NAME]).toEqual([[txt]]);

			const report = await runReplay(inputs, { old: oracleOldStack, new: owlatNewStack });
			expect(report.byCategory['dkim-verdict']).toBe(1);
			expect(report.unsanctionedDivergences).toBe(0);
			expect(report.sanctionedByKind['dkim-l-neutral']).toBe(1);
			const div = report.results[0]?.divergences.find((d) => d.category === 'dkim-verdict');
			expect(div?.oldValue).toBe('pass');
			expect(div?.newValue).toBe('neutral');
			expect(div?.sanction).toBe('dkim-l-neutral');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('divergence categorization', () => {
	it('flags an UNSANCTIONED parse-field divergence and counts it', () => {
		const base: RoutingDrivers = owlatNewStack.project(
			readFileSync(join(CORPUS_DIR, 'plain-text.eml'))
		);
		const mutated: RoutingDrivers = { ...base, subject: `${base.subject} (tampered)` };
		const divs = diffDrivers(base, mutated);
		expect(divs).toHaveLength(1);
		expect(divs[0]?.field).toBe('subject');
		expect(divs[0]?.category).toBe('parse-field');
		expect(divs[0]?.sanctioned).toBe(false);
	});

	it('a pre-signed charset parse-field divergence is SANCTIONED (I2 b), excluded from the gate', () => {
		const base: RoutingDrivers = owlatNewStack.project(
			readFileSync(join(CORPUS_DIR, 'plain-text.eml'))
		);
		const mutated: RoutingDrivers = {
			...base,
			text: { present: true, length: 3, sha256: 'a'.repeat(64) },
		};
		const divs = diffDrivers(base, mutated, { text: 'charset' });
		expect(divs).toHaveLength(1);
		expect(divs[0]?.sanctioned).toBe(true);
		expect(divs[0]?.sanction).toBe('charset');
	});

	it('the l= body-length divergence (pass -> neutral) is SANCTIONED (I2 a)', () => {
		const oldAuth: AuthVerdicts = { dkim: 'pass' };
		const newAuth: AuthVerdicts = { dkim: 'neutral', dkimContext: { hadLTag: true } };
		const divs = diffAuth(oldAuth, newAuth);
		expect(divs).toHaveLength(1);
		expect(divs[0]?.category).toBe('dkim-verdict');
		expect(divs[0]?.sanctioned).toBe(true);
		expect(divs[0]?.sanction).toBe('dkim-l-neutral');
	});

	it('the rsa-sha1 policy divergence (pass -> fail) is SANCTIONED (I2 d)', () => {
		const divs = diffAuth(
			{ dkim: 'pass' },
			{ dkim: 'fail', dkimContext: { algorithm: 'rsa-sha1' } }
		);
		expect(divs[0]?.sanction).toBe('rsa-sha1-policy');
	});

	it('a plain pass -> fail DKIM divergence with no context is UNSANCTIONED', () => {
		const divs = diffAuth({ dkim: 'pass' }, { dkim: 'fail' });
		expect(divs).toHaveLength(1);
		expect(divs[0]?.sanctioned).toBe(false);
	});

	it('an SPF verdict divergence is always UNSANCTIONED', () => {
		const divs = diffAuth({ spf: 'pass' }, { spf: 'fail' });
		expect(divs[0]?.category).toBe('spf-verdict');
		expect(divs[0]?.sanctioned).toBe(false);
	});
});

describe('I7 — the harness never writes decoded body text to a log or report', () => {
	it('no driver record, formatted report, or JSON carries the body marker', async () => {
		const raw = readFileSync(join(CORPUS_DIR, 'plain-text.eml'));
		expect(raw.toString('latin1')).toContain(BODY_MARKER); // the raw DOES carry it

		const drivers = owlatNewStack.project(raw);
		expect(JSON.stringify(drivers)).not.toContain(BODY_MARKER);

		const report = await runReplay(loadCorpus(CORPUS_DIR), {
			old: oracleOldStack,
			new: owlatNewStack,
		});
		expect(formatReport(report)).not.toContain(BODY_MARKER);
		expect(JSON.stringify(report)).not.toContain(BODY_MARKER);
	});

	it('saveDivergent writes the raw .eml but keeps the divergence JSON body-free', async () => {
		const raw = readFileSync(join(CORPUS_DIR, 'plain-text.eml'));
		const input: ReplayInput = { id: 'marker-msg', raw };
		// Force a divergence so the message is saved to the regression corpus.
		const mutatedNew: ReplayStackSide = {
			project(bytes: Buffer): RoutingDrivers {
				const d = owlatNewStack.project(bytes);
				return { ...d, subject: `${d.subject} (changed)` };
			},
		};
		const report = await runReplay([input], { old: oracleOldStack, new: mutatedNew });
		expect(report.totalDivergences).toBe(1);

		const outDir = mkdtempSync(join(tmpdir(), 'replay-regression-'));
		try {
			const saved = saveDivergent(report, [input], outDir);
			expect(saved).toContain('marker-msg');
			const eml = readFileSync(join(outDir, 'marker-msg.eml'), 'latin1');
			const log = readFileSync(join(outDir, 'marker-msg.divergence.json'), 'utf8');
			expect(eml).toContain(BODY_MARKER); // the regression fixture keeps the raw bytes
			expect(log).not.toContain(BODY_MARKER); // the log never carries the body
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	});
});
