/**
 * Drift guard: the tier union declared in `convex/ostr/signals.ts` against the
 * one `@owlat/ostr-core` publishes.
 *
 * `signals.ts` restates the five tiers instead of importing `Tier`, because the
 * Convex tsconfig typechecks against the Convex runtime's `lib` (ES2021) and the
 * ostr-core barrel does not compile under it (one `Object.hasOwn` in
 * `attestation/validate.ts`). A restated union is a copy, and a copy that
 * nothing compares is a copy that drifts: a sixth tier added to the spec would
 * be silently dropped at the webhook boundary with no test turning red.
 *
 * So compare the two as TEXT, which needs no import and therefore no compile.
 * When ostr-core compiles under the Convex lib, delete this file and replace it
 * with the real thing — `import type { Tier }` in `signals.ts` plus a
 * bidirectional `extends` assertion, which the compiler checks for free.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { isOstrTier, OSTR_TIERS } from '../signals';

const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const CORE_TYPES = join(REPOSITORY_ROOT, 'packages/ostr-core/src/types.ts');

/**
 * The string literals of ostr-core's `export type Tier = 'a' | 'b' | …;`.
 *
 * Throws rather than returning empty if the declaration moved or was renamed: a
 * pin that quietly compares nothing is worse than no pin at all.
 */
function coreTiers(): string[] {
	const source = readFileSync(CORE_TYPES, 'utf8');
	const declaration = /export type Tier =([^;]+);/.exec(source);
	if (!declaration) {
		throw new Error(
			`No \`export type Tier\` declaration in ${CORE_TYPES}. If ostr-core moved it, ` +
				'point this pin at the new home — do not delete the pin.'
		);
	}
	const literals = [...declaration[1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
	if (literals.length === 0) throw new Error(`\`Tier\` in ${CORE_TYPES} has no string literals.`);
	return literals;
}

describe('OstrTier is pinned to @owlat/ostr-core#Tier', () => {
	it('declares exactly the tiers ostr-core declares — no more, no fewer', () => {
		const tiers = coreTiers();
		// Sanity: the spec's five (plan §6.1). Catches a regex that matched the
		// wrong declaration as well as a genuine spec change.
		expect(tiers).toEqual(['unknown', 'establishing', 'trusted', 'warned', 'flagged']);
		// Same members, same order — the union here IS core's `Tier`.
		expect([...OSTR_TIERS]).toEqual(tiers);
	});

	it('narrows to that union and nothing near it', () => {
		for (const tier of coreTiers()) {
			expect(isOstrTier(tier), tier).toBe(true);
		}
		for (const notATier of ['Unknown', 'FLAGGED', 'banned', 'quarantined', 'good', '']) {
			expect(isOstrTier(notATier), notATier).toBe(false);
		}
	});
});
