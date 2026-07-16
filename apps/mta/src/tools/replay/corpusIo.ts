/**
 * Corpus IO for the inbound shadow-replay harness (piece C0): load a corpus
 * directory, persist divergent messages to a regression corpus, and render the
 * categorized report. Only field names, categories, verdicts and body DIGESTS
 * are ever written to a log — never decoded body text (I7).
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { SanctionedFields } from './diff.js';
import type { ReplayReport } from './report.js';
import type { DkimCorpusHint, ReplayEnvelope, ReplayInput } from './stacks.js';

/** Raw shape of an optional `<stem>.json` sidecar next to a corpus `.eml`. */
interface CorpusSidecar {
	readonly envelope?: ReplayEnvelope;
	readonly dkim?: DkimCorpusHint;
	readonly sanctionedFields?: SanctionedFields;
}

/** Read an optional `<stem>.json` sidecar; a missing file is the only swallowed case. */
function readSidecar(path: string): CorpusSidecar {
	try {
		return JSON.parse(readFileSync(path, 'utf8')) as CorpusSidecar;
	} catch (err) {
		// A missing sidecar is expected (a plain message with no metadata). Anything
		// else — malformed JSON, a permission error — must surface: silently
		// dropping dkim.records / sanctionedFields would weaken the gate.
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
		throw err;
	}
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
		const sidecar = readSidecar(join(dir, `${id}.json`));
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
