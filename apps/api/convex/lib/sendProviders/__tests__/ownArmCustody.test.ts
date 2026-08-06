/**
 * THE POST-CONDITION OF THE LEAK SWEEP (seams plan P0.4), pinned.
 *
 * D3 sanctions exactly one identity — own vs. not-own — and says every other
 * "is this our own MTA?" test READS its declaration rather than restating the
 * literal. The sweep converted them; nothing stopped the next one from being
 * written, and a restated own-arm literal is invisible in review precisely
 * because it looks like ordinary code.
 *
 * SO THIS IS A SOURCE ASSERTION, deliberately. The behaviour a re-introduced
 * literal breaks is not observable from any single module's tests: today the
 * duplicate and the constant agree, and the failure only arrives on the day the
 * constant changes (a second own-infrastructure kind, a rename) — at which
 * point the arm-keyed measurement plane silently mis-attributes sends and every
 * ramp gate reads a denominator describing an experiment that never ran. The
 * only moment that is catchable is the moment the literal is typed.
 *
 * NARROWER THAN THE RATCHET IT ANTICIPATES. P0.5 adds `bun run lint:providers`,
 * which fails on kind-literal comparisons for EVERY kind against a checked-in,
 * shrink-only allowlist; this checks the one family the sweep actually cleared
 * (own-arm comparisons), so the two never disagree about a kind this piece did
 * not touch. P0.5 subsumes it and deletes it.
 *
 * The surviving non-own-arm literals, their families and their owners are
 * enumerated in the `OWN_ARM_TRANSPORT_KIND` docblock
 * (`strategies/adaptive_mix/index.ts`) — that enumeration is what P0.5 seeds
 * its allowlist from, and it is deliberately not repeated here.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OWN_ARM_TRANSPORT_KIND } from '../strategies/adaptive_mix';

const convexRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Directories the rule does not reach.
 *
 * `lib/sendProviders/<kind>/` and `domains/providers/<kind>/` are the ADAPTER
 * folders — a kind naming itself inside its own module is the whole point of
 * the seam. `migrations/` rewrites rows written under an older spelling and has
 * to keep naming them. `_generated/` is machine-written. Tests state expected
 * values as literals by design, which is what makes them evidence.
 */
const EXEMPT_PREFIXES = [
	'lib/sendProviders/mta/',
	'lib/sendProviders/ses/',
	'lib/sendProviders/smtp/',
	'lib/sendProviders/resend/',
	'lib/sendProviders/mandrill/',
	'domains/providers/',
	'migrations/',
	'_generated/',
];

/**
 * Sites allowed to spell the own arm, and the reason each one is NOT an own-arm
 * check a constant could replace. Two reasons, both about the question being a
 * different question:
 *
 * THE MTA's ROUTING API answers `'mta' | 'relay' | 'defer'` on the wire. That
 * is a different alphabet that happens to share a spelling with the transport
 * kind; rewriting it would change the protocol.
 *
 * THE RETURN-PATH FAMILY asks "which of the two providers that honour a custom
 * MAIL FROM is this?", not "is this our own infrastructure". `'mta'` there is
 * one member of a two-element list whose other member is `'ses'`, so replacing
 * half of it with a constant would read as an own-arm test and mean something
 * else. It is swept when the sending-domain adapter interface grows the
 * return-path capability — see the family enumeration in the
 * `OWN_ARM_TRANSPORT_KIND` docblock, which names its owner.
 */
const ALLOWED_OWN_ARM_LITERALS: Record<string, string> = {
	'delivery/lastMileRouting.ts': "the MTA routing API's `decision.kind` wire vocabulary",
	'domains/lifecycle.ts': "the return-path family's `'mta' | 'ses'` pair",
};

function sourceFiles(dir: string, acc: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
			sourceFiles(full, acc);
			continue;
		}
		if (entry.name.endsWith('.ts')) acc.push(full);
	}
	return acc;
}

/**
 * Comparisons only, and only outside comments.
 *
 * The docblocks that explain the sweep QUOTE the literals they removed —
 * `providerType === 'mta'` appears a dozen times as prose, and a check that
 * could not tell prose from code would force those explanations out of the
 * codebase, which is the opposite of what the rule is for. Block comments and
 * line comments are stripped before matching.
 */
function strippedOfComments(source: string): string {
	return source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const OWN_ARM_COMPARISON = new RegExp(
	`(===|!==|case)\\s*'${OWN_ARM_TRANSPORT_KIND}'|'${OWN_ARM_TRANSPORT_KIND}'\\s*(===|!==)`,
	'g'
);

describe('own-arm custody has exactly one declaration', () => {
	const offenders = sourceFiles(convexRoot)
		.map((file) => ({
			path: relative(convexRoot, file).replaceAll('\\', '/'),
			source: strippedOfComments(readFileSync(file, 'utf8')),
		}))
		.filter((file) => !EXEMPT_PREFIXES.some((prefix) => file.path.startsWith(prefix)))
		.filter((file) => !file.path.endsWith('.test.ts'))
		.map((file) => ({ path: file.path, hits: file.source.match(OWN_ARM_COMPARISON) ?? [] }))
		.filter((file) => file.hits.length > 0);

	it('walks a real tree', () => {
		// A globbing bug that matched nothing would make every assertion below
		// vacuously true, so prove the sweep's own subjects are in scope.
		const scanned = sourceFiles(convexRoot).map((file) =>
			relative(convexRoot, file).replaceAll('\\', '/')
		);
		expect(scanned).toContain('delivery/sendLifecycle.ts');
		expect(scanned).toContain('webhooks/dispatcher.ts');
		expect(scanned.length).toBeGreaterThan(200);
	});

	it('leaves no restated own-arm comparison outside the adapter folders', () => {
		const unexplained = offenders.filter((file) => !(file.path in ALLOWED_OWN_ARM_LITERALS));
		expect(
			unexplained.map((file) => file.path),
			`These files compare a kind to '${OWN_ARM_TRANSPORT_KIND}' instead of reading ` +
				'OWN_ARM_TRANSPORT_KIND (send transports) or OWN_SENDING_DOMAIN_PROVIDER_KIND ' +
				'(domains.providerType). Read the constant; do not add an entry here.'
		).toEqual([]);
	});

	it('keeps the allowlist honest — every entry still has a literal to explain', () => {
		// Shrink-only, enforced rather than promised: an entry whose literal has
		// since been swept must be deleted, or the next restatement in that file
		// inherits a pass it did not earn.
		const withLiterals = new Set(offenders.map((file) => file.path));
		const stale = Object.keys(ALLOWED_OWN_ARM_LITERALS).filter((path) => !withLiterals.has(path));
		expect(stale, 'these allowlist entries no longer have a literal — delete them').toEqual([]);
	});
});
