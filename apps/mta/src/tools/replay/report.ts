/**
 * The replay engine for the inbound shadow-replay harness (piece C0): run every
 * input through both stacks and produce a categorized divergence report. Every
 * divergence carries hashed bodies only, so the report is body-safe (I7).
 */

import {
	diffAuth,
	diffDrivers,
	type Divergence,
	type DivergenceCategory,
	type SanctionKind,
} from './diff.js';
import type { ReplayInput, ReplayStacks } from './stacks.js';

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
	return { 'dkim-l-neutral': 0, 'rsa-sha1-policy': 0, charset: 0 };
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
