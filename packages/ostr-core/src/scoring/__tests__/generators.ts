/**
 * Deterministic builders and pseudo-random generators for the scoring tests.
 *
 * The "random" here is a seeded LCG: a failing property test reproduces
 * exactly, and a green run means the same thing on every machine. No
 * `Math.random`, no `Date.now` — the policy under test forbids both, and so
 * does its test suite.
 */

import type {
	Attestation,
	AttestationKind,
	SequencedAttestation,
	SubjectRef,
} from '../../types.js';

export const AS_OF = '2026-08-20T00:00:00Z';
const DAY_MS = 86_400_000;
const SIG = 'ed25519:c2lnbmF0dXJlLXBsYWNlaG9sZGVy';

/** RFC 3339 timestamp `days` before {@link AS_OF}. Negative days are in the future. */
export function daysBefore(days: number, asOf: string = AS_OF): string {
	return new Date(Date.parse(asOf) - days * DAY_MS).toISOString().replace('.000Z', 'Z');
}

/** Numeric Recipes LCG — 32-bit, reproducible, good enough to permute inputs. */
export function lcg(seed: number): () => number {
	let state = seed >>> 0;
	return (): number => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

/** Fisher-Yates driven by a seeded LCG; never mutates the input. */
export function shuffle<T>(items: readonly T[], random: () => number): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		const a = out[i] as T;
		const b = out[j] as T;
		out[i] = b;
		out[j] = a;
	}
	return out;
}

export interface EntryOptions {
	logId?: string;
	index: number;
	loggedAtDaysAgo?: number;
	observer: string;
	subject: SubjectRef;
	windowFromDaysAgo?: number;
	windowToDaysAgo?: number;
}

export function entry(
	kind: AttestationKind,
	body: unknown,
	options: EntryOptions
): SequencedAttestation {
	const attestation: Attestation = {
		v: 1,
		kind,
		observer: options.observer,
		subject: options.subject,
		body,
		sig: SIG,
	};
	if (options.windowFromDaysAgo !== undefined && options.windowToDaysAgo !== undefined) {
		attestation.window = {
			from: daysBefore(options.windowFromDaysAgo),
			to: daysBefore(options.windowToDaysAgo),
		};
	}
	return {
		logId: options.logId ?? 'log-a',
		index: options.index,
		loggedAt: daysBefore(options.loggedAtDaysAgo ?? 1),
		attestation,
	};
}

export interface TrafficOptions extends EntryOptions {
	messages: number;
	passRate?: number;
	bounceBucket?: number;
}

export function trafficEntry(options: TrafficOptions): SequencedAttestation {
	const rate = options.passRate ?? 1;
	const passes = Math.round(options.messages * rate);
	return entry(
		'traffic-summary',
		{
			messages: options.messages,
			spfPass: passes,
			dkimPass: passes,
			dmarcPass: passes,
			tlsInbound: options.messages,
			uniqueRecipientsBucket: 3,
			bounceRateBucket: options.bounceBucket ?? 0,
		},
		options
	);
}

export interface ReportOptions extends EntryOptions {
	reports: number;
}

export function reportEntry(options: ReportOptions): SequencedAttestation {
	return entry(
		'spam-report-batch',
		{
			reports: options.reports,
			commitment: 'b1'.repeat(32),
		},
		options
	);
}

export interface AccusationOptions extends ReportOptions {
	/** Volume the accuser attests for the same window — required by plan §7.3. */
	volume: number;
	volumePassRate?: number;
	volumeIndex?: number;
}

/**
 * A report batch together with the reporting observer's own traffic summary for
 * the same window. Since plan §7.3 makes that summary an admissibility
 * precondition, a bare `reportEntry` is inert and every complaint fixture needs
 * this pair.
 */
export function accusation(options: AccusationOptions): SequencedAttestation[] {
	return [
		trafficEntry({
			...options,
			index: options.volumeIndex ?? options.index + 1_000,
			messages: options.volume,
			passRate: options.volumePassRate ?? 1,
		}),
		reportEntry(options),
	];
}

export interface TrapOptions extends EntryOptions {
	hits: number;
}

export function trapEntry(options: TrapOptions): SequencedAttestation {
	return entry('trap-hit', { hits: options.hits }, options);
}

/**
 * A clean subject: one to three traffic summaries with perfect authentication
 * from distinct observers, and nothing negative anywhere.
 */
export function cleanSubject(
	random: () => number,
	domain: string
): { entries: SequencedAttestation[]; subject: SubjectRef } {
	const observerCount = 1 + Math.floor(random() * 3);
	const entries: SequencedAttestation[] = [];
	for (let i = 0; i < observerCount; i++) {
		entries.push(
			trafficEntry({
				index: 100 + i,
				logId: i % 2 === 0 ? 'log-a' : 'log-b',
				observer: `observer-${i}.example`,
				subject: { domain },
				messages: 500 + Math.floor(random() * 200_000),
				passRate: 0.9 + random() / 10,
				windowFromDaysAgo: 30 + Math.floor(random() * 500),
				windowToDaysAgo: 2,
				loggedAtDaysAgo: 2,
			})
		);
	}
	if (random() < 0.5) {
		entries.push(
			entry(
				'posture',
				{ dmarcPolicy: 'reject', dnssec: true, mtaSts: random() < 0.5 },
				{ index: 1, observer: domain, subject: { domain }, loggedAtDaysAgo: 400 }
			)
		);
	}
	return { entries, subject: { domain } };
}
