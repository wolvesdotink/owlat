/**
 * THE POST-CONDITION OF THE LEAK SWEEP (seams plan P0.4), pinned — for EVERY
 * kind, not only the one the sweep cleared.
 *
 * D2 says no code outside an adapter folder may compare a kind to a literal;
 * D3 sanctions exactly one exception (own vs. not-own) and says every other "is
 * this our own MTA?" test READS its declaration. The sweep converted what it
 * could. What it could not convert is a SHORT, KNOWABLE LIST, and until P0.4
 * that list existed only as prose in a docblock — so a family that got cleared
 * left a stale claim behind, and a family that appeared was invisible until
 * someone re-read the file.
 *
 * SO THE LIST IS DATA HERE, ASSERTED IN BOTH DIRECTIONS. A literal in a file
 * that is not in {@link SURVIVING_KIND_LITERALS} fails; an entry in that map
 * whose file no longer has one fails and must be deleted. That is the
 * shrink-only property P0.5's `lint:providers` allowlist needs, enforced rather
 * than promised, and this map is what that ratchet seeds from — with each entry
 * carrying its FAMILY and its OWNER, so the allowlist never has to pass a
 * survivor off as "definitional".
 *
 * WHY A SOURCE ASSERTION. The behaviour a restated literal breaks is not
 * observable from any single module's tests: today the duplicate and the
 * constant agree, and the failure arrives on the day the constant changes (a
 * second own-infrastructure kind, a rename) — at which point the arm-keyed
 * measurement plane silently mis-attributes sends and every ramp gate reads a
 * denominator describing an experiment that never ran. The only catchable
 * moment is the moment the literal is typed.
 *
 * NARROWER THAN THE RATCHET IT SEEDED, still: `lint:providers`
 * (`scripts/check-provider-identity.sh`, P0.5) runs in CI's lint job over the
 * whole of `apps/` and `packages/` — the setup wizard and the transport editor
 * included, which is where provider N+1's host edit would otherwise appear.
 * What it deliberately does NOT take with it is the DECLARATION half below: a
 * catalog entry, an adapter, an event payload and a fixture all legitimately
 * write their own name, so `= 'ses'` is only a leak inside `apps/api/convex`,
 * where this file — a source assertion with the whole module graph in hand —
 * is the cheaper place to say so. This file therefore stays: comparisons
 * everywhere are the ratchet's, declarations in the backend are this one's.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEND_TRANSPORT_KINDS } from '@owlat/shared';
import { OWN_ARM_TRANSPORT_KIND } from '../strategies/adaptive_mix';

const convexRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Directories the rule does not reach.
 *
 * The per-kind ADAPTER folders are derived from the catalog rather than listed,
 * so a new core kind's folder is exempt the moment it exists and a retired
 * kind's exemption disappears with it — a hand-written list is how a folder
 * stays exempt after the kind it belonged to is gone. `domains/providers/` and
 * `webhooks/adapters/` are the other two per-kind bundles (domain identity and
 * feedback); a kind naming itself inside its own module is the whole point of
 * the seam. `migrations/` rewrites rows written under an older spelling and has
 * to keep naming them. `_generated/` is machine-written. Tests state expected
 * values as literals by design, which is what makes them evidence.
 */
const EXEMPT_PREFIXES = [
	...SEND_TRANSPORT_KINDS.map((kind) => `lib/sendProviders/${kind}/`),
	'domains/providers/',
	'webhooks/adapters/',
	'migrations/',
	'_generated/',
];

/**
 * Every file outside an adapter folder that still spells a transport kind, the
 * FAMILY it belongs to, and who clears it.
 *
 * None of these is an own-arm restatement, and none may be passed off to P0.5
 * as "definitional" — the definitional entries are exactly the two declarations
 * at the bottom of this map. The rest are capability gaps with named owners.
 */
const SURVIVING_KIND_LITERALS: Record<string, { family: string; owner: string }> = {
	'domains/lifecycle.ts': {
		family: 'return-path',
		owner:
			'the sending-domain adapter interface growing the return-path capability ' +
			'(domains/providers/index.ts states the gap in full)',
	},
	'delivery/checklistDomainValidators.ts': {
		family: 'return-path',
		owner: 'the same capability — the domain.return_path item restates the lifecycle branch',
	},
	'delivery/checklistValidatorTypes.ts': {
		family: 'frozen-sibling-read',
		owner:
			'P1.2 — replaced by asking the loaded rows which kind they belong to, once the ' +
			'generic sendingDomainRelayIdentities read lands',
	},
	'domains/mandrillRelay.ts': {
		family: 'adapter-adjacent',
		owner: "one kind's provisioning actions living beside its adapter (docs/abstractions.md)",
	},
	'domains/mandrillRelayMutations.ts': {
		family: 'adapter-adjacent',
		owner: 'the same move',
	},
	'webhooks/mandrillRejectSuppression.ts': {
		family: 'adapter-adjacent',
		owner: "the same move — one kind's reject-suppression sync beside its inbound adapter",
	},
	'delivery/lastMileRouting.ts': {
		family: 'wire-vocabulary',
		owner:
			"nobody: the MTA routing API's decision.kind is 'mta' | 'relay' | 'defer' on the " +
			'response, a different alphabet that happens to share a spelling. Rewriting it ' +
			'would change the protocol.',
	},
	'lib/sendProviders/strategies/adaptive_mix/index.ts': {
		family: 'definitional',
		owner: 'nobody: OWN_ARM_TRANSPORT_KIND is D3’s one sanctioned declaration',
	},
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

/**
 * Comparisons AND declarations.
 *
 * A comparison is the leak the plan names, but a `const X = 'ses'` is the same
 * fact with an extra hop — `RELAY_IDENTITY_PROOF_KIND` is exactly that, and a
 * scan that only saw `===` would have let this piece ADD a survivor while
 * reporting the family list complete. Object properties (`kind: 'ses'`,
 * `providerType: 'mta'`) are NOT matched: those are the adapters and the
 * events declaring what they are, which is the seam working.
 */
function literalPattern(kind: string): RegExp {
	return new RegExp(`(===|!==|case|=)\\s*'${kind}'|'${kind}'\\s*(===|!==)`, 'g');
}

const offenders = sourceFiles(convexRoot)
	.map((file) => ({
		path: relative(convexRoot, file).replaceAll('\\', '/'),
		source: strippedOfComments(readFileSync(file, 'utf8')),
	}))
	.filter((file) => !EXEMPT_PREFIXES.some((prefix) => file.path.startsWith(prefix)))
	.filter((file) => !file.path.endsWith('.test.ts'))
	.map((file) => ({
		path: file.path,
		kinds: SEND_TRANSPORT_KINDS.filter((kind) => literalPattern(kind).test(file.source)),
	}))
	.filter((file) => file.kinds.length > 0);

describe('kind literals outside the adapter folders are an enumerated, shrinking set', () => {
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

	it('leaves no kind literal that is not enumerated with a family and an owner', () => {
		const unexplained = offenders.filter((file) => !(file.path in SURVIVING_KIND_LITERALS));
		expect(
			unexplained.map((file) => `${file.path} (${file.kinds.join(', ')})`),
			'These files compare or declare a provider kind as a literal. Ask the catalog ' +
				'(lib/sendProviders/catalog.ts) or, for own-vs-not-own, read OWN_ARM_TRANSPORT_KIND / ' +
				'OWN_SENDING_DOMAIN_PROVIDER_KIND. Adding an entry to SURVIVING_KIND_LITERALS is a ' +
				'plan change, not a fix.'
		).toEqual([]);
	});

	it('keeps the enumeration honest — every entry still has a literal to explain', () => {
		// Shrink-only, enforced rather than promised: an entry whose literal has
		// since been swept must be deleted, or the next restatement in that file
		// inherits a pass it did not earn — and P0.5's allowlist, which seeds from
		// this map, would inherit it too.
		const withLiterals = new Set(offenders.map((file) => file.path));
		const stale = Object.keys(SURVIVING_KIND_LITERALS).filter((path) => !withLiterals.has(path));
		expect(stale, 'these entries no longer have a literal — delete them').toEqual([]);
	});

	it('leaves no restated own-arm comparison at all', () => {
		// The one family the sweep actually CLEARED, so it gets the strict rule:
		// zero survivors, not an enumeration. `domains/lifecycle.ts` is the single
		// exception, and only because its `'mta'` is one member of the return-path
		// family's two-element list — replacing half of it with a constant would
		// read as an own-arm test and mean something else.
		const ownArm = new RegExp(
			`(===|!==|case)\\s*'${OWN_ARM_TRANSPORT_KIND}'|'${OWN_ARM_TRANSPORT_KIND}'\\s*(===|!==)`,
			'g'
		);
		const restated = sourceFiles(convexRoot)
			.map((file) => ({
				path: relative(convexRoot, file).replaceAll('\\', '/'),
				source: strippedOfComments(readFileSync(file, 'utf8')),
			}))
			.filter((file) => !EXEMPT_PREFIXES.some((prefix) => file.path.startsWith(prefix)))
			.filter((file) => !file.path.endsWith('.test.ts'))
			.filter((file) => ownArm.test(file.source))
			.map((file) => file.path)
			.filter((path) => path !== 'domains/lifecycle.ts' && path !== 'delivery/lastMileRouting.ts');
		expect(
			restated,
			`These files compare a kind to '${OWN_ARM_TRANSPORT_KIND}' instead of reading ` +
				'OWN_ARM_TRANSPORT_KIND (send transports) or OWN_SENDING_DOMAIN_PROVIDER_KIND ' +
				'(domains.providerType). Read the constant.'
		).toEqual([]);
	});

	it('names a family and an owner for every survivor', () => {
		// Prose with no shape is prose that rots. Each entry has to say WHICH
		// family it belongs to and WHO clears it, because that pair is what P0.5's
		// allowlist carries and what a reviewer checks a new entry against.
		for (const [path, entry] of Object.entries(SURVIVING_KIND_LITERALS)) {
			expect(entry.family, `${path} has no family`).toMatch(/^[a-z-]+$/);
			expect(entry.owner.length, `${path} has no owner`).toBeGreaterThan(10);
		}
		expect(new Set(Object.values(SURVIVING_KIND_LITERALS).map((entry) => entry.family))).toEqual(
			new Set([
				'return-path',
				'frozen-sibling-read',
				'adapter-adjacent',
				'wire-vocabulary',
				'definitional',
			])
		);
	});
});
