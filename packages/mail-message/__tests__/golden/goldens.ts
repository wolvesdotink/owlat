/**
 * The golden .eml corpus — the "insurance policy" half of piece R2.
 *
 * A golden is the EXACT wire output our own stack produces for one M2 corpus
 * case: `composeMessage(input)` (the RFC 5322 / MIME builder that replaced
 * nodemailer) followed by `signMessage(raw, key)` (the DKIM signer that replaced
 * mailauth). Every case in the reviewed M2 corpus (`__tests__/fixtures/corpus.ts`)
 * has one committed `<name>.eml` under this directory, produced by this module.
 *
 * Why this exists on top of the differentials: the compose differential proves
 * our output is SEMANTICALLY equal to nodemailer's (parsed equality, boundaries
 * free to differ); the goldens pin the LITERAL BYTES so an accidental change to
 * folding, header order, boundary derivation, CTE choice or the DKIM assembly is
 * caught even when it stays semantically valid. And because the signature is
 * checked in, CI re-verifies it under mailauth on every run (I1/I6): our signer
 * must keep producing bytes an independent verifier accepts as `pass`.
 *
 * Determinism (so the committed bytes are reproducible):
 *   - `composeMessage` is seeded per case (`boundarySeed = case.name`) and every
 *     case pins `messageId` + `date`, so the MIME bytes are fixed.
 *   - `signMessage` is handed the fixed {@link GOLDEN_DKIM_PRIVATE_KEY} and the
 *     frozen {@link GOLDEN_SIGN_TIME_MS}, so the `DKIM-Signature` (incl. `t=`) is
 *     fixed.
 * Regeneration is therefore idempotent and lives behind `bun run goldens:update`.
 *
 * This module is the SINGLE source of truth shared by the regenerator
 * (`scripts/generate-goldens.ts`) and the tests (`__tests__/golden.test.ts`,
 * `src/__tests__/goldenParse.differential.test.ts`): they compose+sign through
 * exactly the same path so "what the script writes" and "what the test expects"
 * can never drift.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { composeMessage } from '../../src/compose/compose';
import { signMessage, type DkimSigningKey } from '../../src/compose/dkim';
import { CORPUS, toComposeInput, type CorpusCase } from '../fixtures/corpus';
import {
	GOLDEN_DKIM_DOMAIN,
	GOLDEN_DKIM_PRIVATE_KEY,
	GOLDEN_DKIM_SELECTOR,
	GOLDEN_SIGN_TIME_MS,
} from './keyMaterial';

/** The resolved signing material every golden is signed with. */
export const GOLDEN_SIGNING_KEY: DkimSigningKey = {
	domainName: GOLDEN_DKIM_DOMAIN,
	keySelector: GOLDEN_DKIM_SELECTOR,
	privateKey: GOLDEN_DKIM_PRIVATE_KEY,
};

/** Absolute path to this `golden/` directory — where the `.eml` files live. */
export const GOLDEN_DIR = dirname(fileURLToPath(import.meta.url));

/** The full M2 corpus, in the same order the differentials iterate it. */
export const GOLDEN_CASES: readonly CorpusCase[] = CORPUS;

/** The committed file name for a case (`<name>.eml`, matching the case name). */
export function goldenFileName(testCase: CorpusCase): string {
	return `${testCase.name}.eml`;
}

/** Absolute path to a case golden `.eml`. */
export function goldenPath(testCase: CorpusCase): string {
	return join(GOLDEN_DIR, goldenFileName(testCase));
}

/**
 * Deterministically produce the golden wire bytes for a case: compose the MIME
 * message, then prepend the hardened `DKIM-Signature`. This is the ONE function
 * both the regenerator and the byte-diff test call, so the committed bytes and
 * the expected bytes are computed identically.
 */
export function buildGolden(testCase: CorpusCase): Buffer {
	const composed = composeMessage(toComposeInput(testCase)).raw;
	return signMessage(composed, GOLDEN_SIGNING_KEY, GOLDEN_SIGN_TIME_MS);
}

/** Read a case committed golden `.eml` from disk (raw bytes). */
export function readGolden(testCase: CorpusCase): Buffer {
	return readFileSync(goldenPath(testCase));
}
