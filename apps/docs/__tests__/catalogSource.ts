import { expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * THE ONE READER of `CORE_SEND_PROVIDER_CATALOG` in this workspace.
 *
 * Two docs suites need the catalog's entries — `providerCapabilityDocs` pins the
 * providers page's capability table cell by cell, `contextVocabularyDocs` pins
 * the kinds `CONTEXT.md` names — and they had a parser each. Same anchor, but
 * different slice TERMINATORS (`] as const satisfies` versus `] as const`), which
 * is the failure this file removes: change the declaration's tail and one
 * parser's window moves while the other's does not, so one suite fails loudly
 * and the other keeps asserting, greenly, over the wrong set of entries. Parsing
 * one fact twice is the defect both suites exist to catch.
 *
 * A third reader lives outside this workspace and cannot import from here:
 * `scripts/check-provider-identity.sh`, which needs the kinds in shell before
 * any TypeScript runs. Its parser is documented as deliberately mirroring THIS
 * one; if the anchor or the entry shape changes, both change together.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

// Not exported: a second suite that imported the path would be one `readFileSync`
// away from a second parser beside it, which is the duplication this module exists
// to remove. Callers ask for entries or kinds, never for the file.
const CATALOG_PATH = 'packages/shared/src/sendProviderCatalogData.ts';

/** One core catalog entry: its kind, and the source text that declares it. */
export interface CoreCatalogEntry {
	readonly kind: string;
	readonly body: string;
}

/**
 * Every core catalog entry, as the literal declares it.
 *
 * The slice ends at the ARRAY's own terminator, matched with the `satisfies`
 * clause that only the outermost `] as const` in this file carries — a nested
 * `as const` would otherwise cut the window short and the parse would silently
 * return the first few entries. A terminator this function cannot find is a
 * failure rather than a slice to end-of-file.
 */
export function coreCatalogEntries(): CoreCatalogEntry[] {
	const source = readFileSync(resolve(repoRoot, CATALOG_PATH), 'utf8');
	const start = source.indexOf('const CORE_SEND_PROVIDER_CATALOG = [');
	expect(start, `${CATALOG_PATH} no longer declares CORE_SEND_PROVIDER_CATALOG`).toBeGreaterThan(
		-1
	);
	const end = source.indexOf('] as const satisfies', start);
	expect(end, 'the core catalog array no longer ends in `] as const satisfies`').toBeGreaterThan(
		start
	);
	const block = source.slice(start, end);
	// TWO TABS: an ENTRY's `kind:`. Credential-field descriptors (D5) nest one
	// level deeper and carry a `kind:` of their own (`kind: 'secret'`), which this
	// anchor must not read as a transport kind — the same anchor, for the same
	// reason, as the kind parser in scripts/check-provider-identity.sh.
	const marks = [...block.matchAll(/\n\t\tkind: '([a-z][a-zA-Z0-9]*)',/g)];
	expect(marks.length, 'no catalog entries parsed').toBeGreaterThan(1);
	return marks.map((mark, index) => ({
		kind: mark[1]!,
		body: block.slice(mark.index!, marks[index + 1]?.index ?? block.length),
	}));
}

/** Every core transport kind the catalog declares, in declaration order. */
export function coreCatalogKinds(): string[] {
	return coreCatalogEntries().map((entry) => entry.kind);
}
