/**
 * The golden-corpus gate (piece R2). Two independent checks per committed
 * `.eml`, on every CI run:
 *
 *   1. BYTE-FOR-BYTE: recompute the golden from the corpus case through the exact
 *      same compose + DKIM-sign path ({@link buildGolden}) and assert it equals
 *      the committed file, byte for byte. This is stricter than the compose
 *      differential (which only requires semantic parity with nodemailer): an
 *      accidental change to header folding, header order, boundary derivation,
 *      CTE selection or the `DKIM-Signature` assembly moves the bytes and trips
 *      here even when the output stays a valid, parseable message.
 *
 *   2. DKIM RE-VERIFICATION under mailauth (the independent oracle, kept as a
 *      devDependency, I1): every committed golden must still verify `pass` under
 *      mailauth using the matching public key. This closes the loop the signer
 *      unit test opens — the bytes we ship, parsed and verified by a foreign
 *      implementation, are accepted (I6: our signer output verifies pass).
 *
 * The committed set is also pinned to the corpus: exactly one golden per case,
 * no orphans, no gaps — so a case added to / removed from the corpus without
 * running `bun run goldens:update` fails the suite rather than silently drifting.
 */

import { readdirSync } from 'node:fs';
import { describe, it, expect, beforeAll } from 'vitest';
import { dkimVerify } from 'mailauth';

import {
	GOLDEN_CASES,
	GOLDEN_DIR,
	buildGolden,
	goldenFileName,
	readGolden,
} from './golden/goldens';
import { GOLDEN_DKIM_TXT_RECORD } from './golden/keyMaterial';

/** The narrow shape of the mailauth `dkimVerify` result we assert on. */
interface MailauthVerifyResult {
	results: Array<{ status: { result: string }; signingDomain?: string; selector?: string }>;
}

/**
 * A fixed DNS resolver answering ONLY the golden selector `TXT` — the public
 * half of {@link GOLDEN_DKIM_PRIVATE_KEY}. No network, deterministic.
 */
const EXPECTED_TXT_NAME = 'golden2026._domainkey.owlat.test';
async function goldenResolver(name: string, rrtype: string): Promise<string[][]> {
	return rrtype === 'TXT' && name === EXPECTED_TXT_NAME ? [[GOLDEN_DKIM_TXT_RECORD]] : [];
}

describe('golden .eml corpus — byte-for-byte + mailauth re-verification', () => {
	it('pins one committed golden per corpus case, with no orphan .eml files', () => {
		const onDisk = new Set(readdirSync(GOLDEN_DIR).filter((f) => f.endsWith('.eml')));
		const expected = new Set(GOLDEN_CASES.map((c) => goldenFileName(c)));
		// No gaps: every case has a committed golden.
		for (const name of expected) {
			expect(onDisk.has(name), `missing golden for ${name} — run "bun run goldens:update"`).toBe(
				true
			);
		}
		// No orphans: every committed golden maps to a live case.
		for (const name of onDisk) {
			expect(expected.has(name), `orphan golden ${name} — run "bun run goldens:update"`).toBe(true);
		}
		// Same cardinality (and the corpus itself is the reviewed >=40-input set).
		expect(onDisk.size).toBe(expected.size);
		expect(GOLDEN_CASES.length).toBeGreaterThanOrEqual(40);
	});

	for (const testCase of GOLDEN_CASES) {
		it(`matches the committed bytes exactly: ${testCase.name}`, () => {
			const regenerated = buildGolden(testCase);
			const committed = readGolden(testCase);
			// Compare as base64 first for a compact, readable diff on mismatch, then
			// assert raw-buffer equality so nothing (length, trailing bytes) slips.
			expect(regenerated.toString('base64')).toBe(committed.toString('base64'));
			expect(regenerated.equals(committed)).toBe(true);
		});
	}

	for (const testCase of GOLDEN_CASES) {
		it(`re-verifies DKIM pass under mailauth: ${testCase.name}`, async () => {
			const committed = readGolden(testCase);
			const result = (await dkimVerify(committed.toString('binary'), {
				resolver: goldenResolver,
			})) as unknown as MailauthVerifyResult;
			expect(result.results.length, `no DKIM result for ${testCase.name}`).toBeGreaterThan(0);
			const first = result.results[0];
			expect(first?.status.result, `mailauth verdict for ${testCase.name}`).toBe('pass');
			expect(first?.signingDomain).toBe('owlat.test');
			expect(first?.selector).toBe('golden2026');
		});
	}
});

describe('golden regeneration is deterministic', () => {
	// The whole gate rests on compose+sign being a pure function of the case; prove
	// it by regenerating each golden twice and asserting byte identity, so a hidden
	// clock / RNG dependency (which would make the committed bytes unreproducible)
	// is caught here rather than as a flaky diff in `goldens:update`.
	let doubled: boolean;
	beforeAll(() => {
		doubled = GOLDEN_CASES.every((c) => buildGolden(c).equals(buildGolden(c)));
	});
	it('produces byte-identical output across two runs of every case', () => {
		expect(doubled).toBe(true);
	});
});
