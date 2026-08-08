import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Docs-lint for the repo-root `CONTEXT.md`, the file that "pins the
 * project-specific language used across architecture decisions".
 *
 * It sits here rather than at the repo root for the same reason
 * `abstractionsDocs.test.ts` does: `apps/docs` is the workspace that already
 * owns doc-consistency suites and already reads repo-relative paths, and a
 * second vitest project rooted at `/` to hold two files would be worse than the
 * import path it saves.
 *
 * Three classes of rot, all of which had already happened by the time this file
 * was written:
 *
 *  1. A COUNTED LIST that a later provider silently invalidated ("Four core
 *     adapters today: mta, ses, resend, smtp" — five had shipped).
 *  2. A CROSS-REFERENCE to a section that does not exist, or that was renamed.
 *     The house spelling for one is `**§ Section name**`, so it is greppable;
 *     this file is what makes it checkable.
 *  3. An `ADR-NNNN` citation with no document behind it. `lint:adr` guarantees
 *     one document per number; nothing guaranteed the number was real.
 *
 * Everything below is pinned to CODE, never to a second copy of the prose.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

function read(relativePath: string): string {
	return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

const context = read('CONTEXT.md');

/** Every `## ` heading, in file order. */
const sectionHeadings = [...context.matchAll(/^## (.+)$/gm)].map((match) => match[1]!.trim());

/**
 * The body of one `## ` section: everything up to the next `## ` heading.
 *
 * Sections are addressed BY NAME because that is what a cross-reference names.
 * A section this helper cannot find is a failure rather than an empty string —
 * an assertion against `''` passes for `not.toContain` and fails silently for
 * everything else, which is the exact failure mode the file exists to catch.
 */
function section(name: string): string {
	const heading = `\n## ${name}\n`;
	const start = context.indexOf(heading);
	expect(start, `CONTEXT.md has no "## ${name}" section`).toBeGreaterThan(-1);
	const bodyStart = start + heading.length;
	const next = context.indexOf('\n## ', bodyStart);
	return next === -1 ? context.slice(bodyStart) : context.slice(bodyStart, next);
}

/**
 * String literals of a `const <NAME> = [ … ] as const` array, read from the
 * declaring module. The same trick `abstractionsDocs.test.ts` uses on object
 * registries, for the shape those vocabularies happen to have.
 */
function constArrayLiterals(relativePath: string, declaration: string): string[] {
	const source = read(relativePath);
	const start = source.indexOf(declaration);
	expect(start, `${relativePath} no longer declares ${declaration}`).toBeGreaterThan(-1);
	const body = source.slice(start, source.indexOf(']', start));
	const values = [...body.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
	expect(values.length, `no values parsed out of ${declaration}`).toBeGreaterThan(1);
	return values;
}

describe('CONTEXT.md: section cross-references resolve', () => {
	const references = [...context.matchAll(/\*\*§ ([^*]+)\*\*/g)].map((match) => match[1]!.trim());

	it('finds the cross-references it is meant to check', () => {
		// Non-triviality: a regex that matched nothing would agree with every
		// broken reference in the file.
		expect(references.length).toBeGreaterThanOrEqual(5);
	});

	it('every `**§ Section**` reference names a real section', () => {
		const dangling = [...new Set(references)].filter((name) => !sectionHeadings.includes(name));
		expect(dangling, `no "## " heading for: ${dangling.join(', ')}`).toEqual([]);
	});

	it('no section cross-references itself', () => {
		// A self-reference is always a copy-paste, and always sends a reader in a
		// circle rather than to the section that actually holds the answer.
		const selfReferencing = sectionHeadings.filter((name) =>
			section(name).includes(`**§ ${name}**`)
		);
		expect(selfReferencing).toEqual([]);
	});
});

describe('CONTEXT.md: ADR citations resolve', () => {
	const adrFiles = readdirSync(resolve(repoRoot, 'docs/adr'));
	const cited = [...new Set([...context.matchAll(/ADR-(\d{4})/g)].map((match) => match[1]!))];

	it('finds the citations it is meant to check', () => {
		expect(cited.length).toBeGreaterThan(5);
	});

	it('every cited ADR number has a document', () => {
		const missing = cited.filter((number) => !adrFiles.some((f) => f.startsWith(`${number}-`)));
		expect(missing, `no docs/adr/${missing.join('|')}-*.md`).toEqual([]);
	});
});

describe('CONTEXT.md: the send-provider catalog section is pinned to the catalog', () => {
	/**
	 * The core kinds, read off the catalog's own entries.
	 *
	 * Not `constArrayLiterals`: this array holds whole entry OBJECTS, so its
	 * string literals are mostly labels, env names and credential-field values.
	 * The kind is the `kind:` at entry depth — two tabs, which nothing nested
	 * inside an entry reaches.
	 */
	const source = read('packages/shared/src/sendProviderCatalog.ts');
	const start = source.indexOf('const CORE_SEND_PROVIDER_CATALOG = [');
	expect(start, 'the core catalog array is gone or renamed').toBeGreaterThan(-1);
	const body = source.slice(start, source.indexOf('\n] as const', start));
	const kinds = [...body.matchAll(/^\t\tkind: '([a-z][a-z0-9]*)',$/gm)].map((match) => match[1]!);

	it('parses mandrill out of the catalog', () => {
		// The kind whose arrival made "four core adapters" false.
		expect(kinds).toContain('mandrill');
		expect(kinds.length).toBeGreaterThanOrEqual(5);
	});

	it('the send-path section names every core kind the catalog declares', () => {
		const providers = section('Send providers');
		const unmentioned = kinds.filter((kind) => !providers.includes(`\`${kind}\``));
		expect(unmentioned, `"Send providers" never names: ${unmentioned.join(', ')}`).toEqual([]);
	});

	it('the send-path section states the adapter count the catalog actually has', () => {
		const providers = section('Send providers');
		const counted = providers.match(/([A-Z][a-z]+) core adapters today:/);
		expect(counted, 'the "N core adapters today" sentence is gone or reworded').not.toBeNull();
		const words = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'];
		expect(counted![1]).toBe(words[kinds.length]);
	});

	it('the catalog section names every credential field kind the vocabulary declares', () => {
		const catalog = section('Send provider catalog');
		const fieldKinds = constArrayLiterals(
			'packages/shared/src/sendProviderCredentialFields.ts',
			'export const SEND_PROVIDER_CREDENTIAL_FIELD_KINDS = ['
		);
		const unmentioned = fieldKinds.filter((kind) => !catalog.includes(`\`${kind}\``));
		expect(unmentioned, `credential field kinds missing: ${unmentioned.join(', ')}`).toEqual([]);
	});

	it('the catalog section names every provider tier', () => {
		const catalog = section('Send provider catalog');
		for (const tier of ['own', 'core', 'plugin']) {
			expect(catalog).toContain(`\`${tier}\``);
		}
	});
});

describe('CONTEXT.md: the ramp section is pinned to the deliverability vocabulary', () => {
	const ramp = () => section('Ramp controller and measurement plane');

	it('names both axes of a deliverability cell', () => {
		const body = ramp();
		for (const stream of constArrayLiterals(
			'packages/shared/src/routingDispatch.ts',
			'export const GOVERNED_MESSAGE_TYPES = ['
		)) {
			expect(body, `stream ${stream} unnamed`).toContain(`\`${stream}\``);
		}
		for (const destination of constArrayLiterals(
			'packages/shared/src/deliverabilityRouting.ts',
			'export const DESTINATION_PROVIDER_KEYS = ['
		)) {
			expect(body, `destination ${destination} unnamed`).toContain(`\`${destination}\``);
		}
	});

	it('names every ramp gate the signal registry declares', () => {
		const body = ramp();
		for (const key of constArrayLiterals(
			'apps/api/convex/delivery/signals/types.ts',
			'export const RAMP_GATE_SIGNAL_KEYS = ['
		)) {
			expect(body, `ramp gate ${key} unnamed`).toContain(`\`${key}\``);
		}
	});

	it('names every signal source family', () => {
		const body = ramp();
		for (const kind of constArrayLiterals(
			'apps/api/convex/delivery/signals/types.ts',
			'export const SIGNAL_SOURCE_KINDS = ['
		)) {
			expect(body, `signal family ${kind} unnamed`).toContain(`\`${kind}\``);
		}
	});

	it('cites the ramp ADR rather than restating its argument', () => {
		const body = ramp();
		const cited = body.match(/ADR-(\d{4})/);
		expect(cited, 'the ramp section cites no ADR').not.toBeNull();
		const number = cited![1]!;
		const file = readdirSync(resolve(repoRoot, 'docs/adr')).find((f) => f.startsWith(`${number}-`));
		expect(file, `ADR-${number} has no document`).toBeDefined();
		expect(read(`docs/adr/${file}`)).toMatch(/ramp controller/i);
	});
});

describe('CONTEXT.md: paths named in the new sections exist', () => {
	/**
	 * House style writes a backend path relative to whichever root the sentence
	 * is standing in — `convex/lib/sendProviders/…`, `delivery/ramp/…`, or just
	 * `ramp/degradationMatrix.ts` inside a paragraph about the ramp. So a path
	 * is tried against the repo root and then against each of those roots, and
	 * the assertion is "this file exists somewhere we address code from", which
	 * is the claim a reader actually relies on.
	 *
	 * Only paths are checked — something with a slash plus a file extension or a
	 * trailing slash. Identifiers, unions and env names are not paths.
	 */
	const roots = ['', 'apps/api/', 'apps/api/convex/', 'apps/api/convex/delivery/'];

	function pathsIn(body: string): string[] {
		return [...new Set([...body.matchAll(/`([^`]+)`/g)].map((match) => match[1]!))].filter(
			(value) => /^[\w.@/-]+(\.(ts|vue|md|json)|\/)$/.test(value) && value.includes('/')
		);
	}

	for (const name of ['Send provider catalog', 'Ramp controller and measurement plane']) {
		it(`every file path in "${name}" resolves`, () => {
			const paths = pathsIn(section(name));
			expect(paths.length, `no paths parsed out of "${name}"`).toBeGreaterThan(3);
			const missing = paths.filter(
				(candidate) => !roots.some((root) => existsSync(resolve(repoRoot, root + candidate)))
			);
			expect(missing, `not on disk: ${missing.join(', ')}`).toEqual([]);
		});
	}
});
