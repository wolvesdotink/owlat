/**
 * Inbound shadow-replay harness — IMAP-shaped slice (piece CI1).
 *
 * The mail-sync ingest cutover (`simpleParser` -> `parseMessage`) reads the
 * SAME routing / delivery drivers the C0 harness already projects (subject,
 * message-id, in-reply-to, references, from/to/cc/bcc/reply-to, text/html
 * digests, attachments). This slice pins the cutover's promise directly: over a
 * corpus of IMAP-mailbox-shaped mail (threaded replies, RFC 2047 encoded +
 * folded headers, a legacy ISO-8859-1 body, a multipart/mixed attachment) the
 * OLD stack (mailparser `simpleParser`) and the NEW in-house stack
 * ({@link owlatNewStack}: `parseMessage`) agree on EVERY routing field — ZERO
 * divergence (I2; the ingest cutover introduces no sanctioned change of its
 * own). mailparser survives here only as the differential oracle (I1) and is
 * wired HERE, never imported by the shipped tool.
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { simpleParser } from 'mailparser';
import {
	loadCorpus,
	owlatNewStack,
	projectDrivers,
	runReplay,
	type ReplayStackSide,
	type RoutingDrivers,
} from '../inboundReplay';

const IMAP_CORPUS_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'__fixtures__',
	'imap-corpus'
);

/** The OLD (oracle) stack: mailparser for the routing drivers ingest reads. */
const oracleOldStack: ReplayStackSide = {
	async project(raw: Buffer): Promise<RoutingDrivers> {
		const parsed = await simpleParser(raw);
		return projectDrivers(parsed, (name) => parsed.headers.get(name));
	},
};

describe('inbound shadow-replay over the IMAP-shaped corpus slice (mail-sync ingest cutover)', () => {
	it('loads every IMAP-shaped .eml in the slice', () => {
		const inputs = loadCorpus(IMAP_CORPUS_DIR);
		expect(inputs.length).toBeGreaterThanOrEqual(4);
		const ids = new Set(inputs.map((i) => i.id));
		expect(ids.size).toBe(inputs.length);
	});

	it('old (simpleParser) vs new (parseMessage) agree on every routing field — zero divergence', async () => {
		const inputs = loadCorpus(IMAP_CORPUS_DIR);
		const report = await runReplay(inputs, { old: oracleOldStack, new: owlatNewStack });

		expect(report.totalMessages).toBe(inputs.length);
		// The whole point of the cutover: NO routing-field divergence, sanctioned
		// or otherwise, on well-formed IMAP mail.
		expect(report.totalDivergences).toBe(0);
		expect(report.unsanctionedDivergences).toBe(0);
		expect(report.byCategory['parse-field']).toBe(0);
		expect(report.results.every((r) => r.divergences.length === 0)).toBe(true);
	});

	it('the ISO-8859-1 message decodes its body identically on both stacks', async () => {
		const inputs = loadCorpus(IMAP_CORPUS_DIR);
		const latin1 = inputs.find((i) => i.id === 'imap-latin1');
		if (latin1 === undefined) throw new Error('imap-latin1 fixture missing');

		const oldDrivers = await oracleOldStack.project(latin1.raw);
		const newDrivers = owlatNewStack.project(latin1.raw);

		// Non-empty digest (the body was actually read), byte-equal across stacks.
		expect(newDrivers.text.present).toBe(true);
		expect(newDrivers.text.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(newDrivers.text.sha256).toBe(oldDrivers.text.sha256);
		expect(newDrivers.subject).toBe(oldDrivers.subject);
	});

	it('the multipart/mixed message exposes the same attachment routing fields', () => {
		const inputs = loadCorpus(IMAP_CORPUS_DIR);
		const mixed = inputs.find((i) => i.id === 'imap-multipart');
		if (mixed === undefined) throw new Error('imap-multipart fixture missing');

		const drivers = owlatNewStack.project(mixed.raw);
		expect(drivers.attachments).toHaveLength(1);
		expect(drivers.attachments[0]?.filename).toBe('chart.png');
		expect(drivers.attachments[0]?.contentType).toBe('image/png');
	});
});
