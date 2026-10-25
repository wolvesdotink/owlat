/**
 * Hostile inputs whose cost is spent inside regular expressions or native
 * string scans, shared by the tests that run them for their result or bound
 * their input and the report-only timing in hostileRegexInputs.perf.test.ts,
 * so the benchmark times exactly what the tests run. Each builds its input
 * from a unit count `n`; the tests run the larger size (SCALING_FACTOR * n),
 * the benchmark both.
 */
import type { ScalingCase } from '../../../../scripts/perf-bench/sample';
import { detectExactWording } from '../exactWordingDetector';
import { extractClearsignedText } from '../secureMessage';

/** The size factor between a case's two benchmark sizes; the tests run the larger. */
export const SCALING_FACTOR = 4;

/**
 * Text that keeps the IBAN and phrase patterns busy: IBAN-shaped runs, country
 * code look-alikes and phrase openers. `n` units of about 50 characters each.
 */
export const wordingBait = (n: number) =>
	`${'A1'.repeat(10 * n)} ${'DE00 '.repeat(4 * n)} ${'notice of '.repeat(n)}`;

/** A clearsigned block whose one line holds `n` spaces between two words. */
export const clearsignedBlankRun = (n: number) =>
	[
		'-----BEGIN PGP SIGNED MESSAGE-----',
		'Hash: SHA256',
		'',
		`Hello${' '.repeat(n)}world  `,
		'-----BEGIN PGP SIGNATURE-----',
		'sig',
		'-----END PGP SIGNATURE-----',
	].join('\n');

export const SHARED_REGEX_CASES: readonly ScalingCase[] = [
	{
		// The body is capped before the patterns run; under the cap it scales.
		name: 'detectExactWording, bait in the body',
		n: 90,
		build: wordingBait,
		run: (input: string) => detectExactWording({ text: input }),
	},
	{
		// The subject is never capped, so its scan grows with it.
		name: 'detectExactWording, bait in the subject',
		n: 1_250,
		build: wordingBait,
		run: (input: string) => detectExactWording({ subject: input, text: '' }),
	},
	{
		name: 'extractClearsignedText, long inner blank run',
		n: 125_000,
		build: clearsignedBlankRun,
		run: (input: string) => extractClearsignedText(input),
	},
];
