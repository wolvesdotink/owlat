/**
 * The provider-identity ratchet's own gate, part three: the two lists it reads
 * and the catalog it follows.
 *
 * The allowlist is debt and drives to zero; the collisions list is permanent
 * vocabulary. They are separate files so a permanent entry cannot hold the debt
 * count above zero forever, and the kind list is read from the catalog so a
 * newly declared provider kind is guarded the day it lands.
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_KINDS, cleanupSandboxes, leak, runIn, sandbox } from './providerIdentity.testlib';

afterEach(cleanupSandboxes);

describe('provider-identity ratchet, the allowlist', () => {
	it('passes a violation in an allowlisted file', () => {
		const root = sandbox({
			files: { 'apps/api/convex/delivery/sanctioned.ts': leak("kind === 'mta'") },
			allowlist: ['apps/api/convex/delivery/sanctioned.ts'],
		});
		const result = runIn(root);

		expect(result.output).toContain('ok:');
		expect(result.output).toContain('1 allowlisted site(s) remain');
		expect(result.status).toBe(0);
	});

	it('fails a stale entry whose file no longer holds a literal, so the list only shrinks', () => {
		const root = sandbox({
			files: { 'apps/api/convex/delivery/cleaned.ts': leak('kind === OWN_ARM_TRANSPORT_KIND') },
			allowlist: ['apps/api/convex/delivery/cleaned.ts'],
		});
		const result = runIn(root);

		expect(result.output).toContain('stale allowlist entr');
		expect(result.output).toContain('apps/api/convex/delivery/cleaned.ts');
		expect(result.output).toContain('only ever moves down');
		expect(result.status).toBe(1);
	});

	it('fails a stale entry whose file is gone', () => {
		const root = sandbox({
			files: { 'apps/api/convex/delivery/kept.ts': leak('kind === OWN_ARM_TRANSPORT_KIND') },
			allowlist: ['apps/api/convex/delivery/deleted.ts'],
		});
		const result = runIn(root);

		expect(result.output).toContain('stale allowlist entr');
		expect(result.output).toContain('apps/api/convex/delivery/deleted.ts');
		expect(result.status).toBe(1);
	});

	it.each([
		['the allowlist', 'scripts/provider-identity-allowlist.txt'],
		['the collisions list', 'scripts/provider-identity-collisions.txt'],
	])('fails when %s is missing', (_label, path) => {
		const root = sandbox({ files: { 'apps/api/convex/delivery/clean.ts': leak('kind === OWN') } });
		rmSync(join(root, path));
		const result = runIn(root);

		expect(result.output).toContain('is missing');
		expect(result.status).toBe(1);
	});

	it('passes with both lists empty — the end state A1 asks for', () => {
		const root = sandbox({ files: { 'apps/api/convex/delivery/clean.ts': leak('kind === OWN') } });
		const result = runIn(root);

		expect(result.output).toContain('0 allowlisted site(s) remain');
		expect(result.status).toBe(0);
	});
});

describe('provider-identity ratchet, the collisions list', () => {
	// Debt and vocabulary collisions are separate files on purpose: the allowlist
	// drives to zero (that count is what A1 measures) and the collisions list is
	// permanent, so a permanent entry must not be able to hold the debt count
	// above zero forever.
	it('licenses a spelling that belongs to another vocabulary', () => {
		const root = sandbox({
			files: { 'apps/web/server/api/setup/apply.post.ts': leak("profiles.includes('mta')") },
			collisions: ['apps/web/server/api/setup/apply.post.ts:mta'],
		});
		const result = runIn(root);

		expect(result.output).toContain('0 allowlisted site(s) remain, 1 vocabulary collision');
		expect(result.status).toBe(0);
	});

	it('licenses that spelling only — a real kind branch in the same file still fails', () => {
		// The collisions list is PERMANENT, so a file-granular licence would blind
		// the gate to this file forever: the compose-profile entry would silently
		// cover a `kind === 'ses'` branch added to the same handler years later.
		const root = sandbox({
			files: {
				'apps/web/server/api/setup/apply.post.ts': [
					'export async function apply(profiles: string[], kind: string) {',
					"\tif (profiles.includes('mta')) await preflight();",
					"\tif (kind === 'ses') await verifyIdentity();",
					'}',
					'',
				].join('\n'),
			},
			collisions: ['apps/web/server/api/setup/apply.post.ts:mta'],
		});
		const result = runIn(root);

		expect(result.output).toContain('apps/web/server/api/setup/apply.post.ts:3');
		expect(result.output).not.toContain('apply.post.ts:2');
		expect(result.status).toBe(1);
	});

	it('fails a qualified entry whose spelling is gone, even though the file still has others', () => {
		const root = sandbox({
			files: { 'apps/api/convex/delivery/moved.ts': leak("kind === 'ses'") },
			allowlist: ['apps/api/convex/delivery/moved.ts'],
			collisions: ['apps/api/convex/delivery/moved.ts:mta'],
		});
		const result = runIn(root);

		expect(result.output).toContain('stale collision entr');
		expect(result.output).toContain('apps/api/convex/delivery/moved.ts:mta');
		expect(result.status).toBe(1);
	});

	it('rejects a qualifier that is not a declared kind, instead of calling it stale', () => {
		const root = sandbox({
			files: { 'apps/api/convex/delivery/leak.ts': leak("kind === 'ses'") },
			collisions: ['apps/api/convex/delivery/leak.ts:postmark'],
		});
		const result = runIn(root);

		expect(result.output).toContain('not a declared kind');
		expect(result.output).toContain('apps/api/convex/delivery/leak.ts:postmark');
		expect(result.status).toBe(1);
	});

	it('fails a stale collision entry, naming its own file', () => {
		const root = sandbox({
			files: { 'apps/api/convex/delivery/cleaned.ts': leak('kind === OWN_ARM_TRANSPORT_KIND') },
			collisions: ['apps/api/convex/delivery/cleaned.ts'],
		});
		const result = runIn(root);

		expect(result.output).toContain('stale collision entr');
		expect(result.output).toContain('scripts/provider-identity-collisions.txt');
		expect(result.status).toBe(1);
	});

	it('points an unlicensed violation at both files, with the right one first', () => {
		const root = sandbox({ files: { 'apps/api/convex/delivery/leak.ts': leak("kind === 'ses'") } });
		const result = runIn(root);

		expect(result.output).toContain('Do NOT add a line to');
		expect(result.output).toContain('scripts/provider-identity-collisions.txt');
		expect(result.status).toBe(1);
	});
});

describe('provider-identity ratchet, the kind list', () => {
	it('follows the catalog: a newly declared kind is guarded the day it lands', () => {
		const files = { 'apps/api/convex/delivery/newKind.ts': leak("kind === 'postmark'") };

		const before = runIn(sandbox({ files }));
		expect(before.output).toContain('ok:');
		expect(before.status).toBe(0);

		const after = runIn(sandbox({ files, kinds: [...DEFAULT_KINDS, 'postmark'] }));
		expect(after.output).toContain('apps/api/convex/delivery/newKind.ts:2');
		expect(after.status).toBe(1);
	});

	it('guards adapter folders of a newly declared kind too', () => {
		const root = sandbox({
			files: { 'apps/api/convex/lib/sendProviders/postmark/index.ts': leak("kind === 'postmark'") },
			kinds: [...DEFAULT_KINDS, 'postmark'],
		});
		const result = runIn(root);

		expect(result.output).toContain('ok:');
		expect(result.status).toBe(0);
	});

	it('reads only the ENTRY kinds, never a credential field\u2019s own `kind:`', () => {
		// The catalog entries carry typed credential-field descriptors (D5), and a
		// descriptor has a `kind:` too — `kind: 'secret'`, `kind: 'host-port'`.
		// A parser that read those as transport kinds would turn every
		// `=== 'secret'` in the repo into a provider-identity violation, and the
		// gate would be unusable the day someone compares a field kind.
		const root = sandbox({
			files: {
				'apps/api/convex/delivery/newKind.ts': leak("kind === 'postmark'"),
				'apps/web/app/utils/fieldKind.ts': leak("field === 'secret'"),
			},
			kinds: [...DEFAULT_KINDS, 'postmark'],
			withCredentialFields: true,
		});
		const result = runIn(root);

		expect(result.output).not.toContain('could not read the send-provider kinds');
		// The new transport kind IS ratcheted...
		expect(result.output).toContain('apps/api/convex/delivery/newKind.ts:2');
		// ...and the field kind that shares the property name is not.
		expect(result.output).not.toContain('apps/web/app/utils/fieldKind.ts');
		expect(result.status).toBe(1);
	});

	it('fails loudly when the kind declaration cannot be read', () => {
		const root = sandbox({
			files: { 'apps/api/convex/delivery/seededLeak.ts': leak("kind === 'ses'") },
			kinds: null,
		});
		const result = runIn(root);

		expect(result.output).toContain('could not read the send-provider kinds');
		expect(result.status).toBe(1);
	});

	it('fails on a PARTIAL parse rather than ratcheting the kinds it managed to read', () => {
		// The array this parser replaced could only succeed or read nothing. A
		// per-line parser can read four entries out of five — and then `kinds` is
		// non-empty, the script prints `ok:` and the fifth kind is un-ratcheted
		// everywhere with no signal at all. That is the failure mode a green gate
		// hides, so the entry openings are counted and a disagreement is fatal.
		const root = sandbox({
			files: { 'apps/api/convex/delivery/newKind.ts': leak("kind === 'postmark'") },
			rawEntries:
				"\t{\n\t\tkind: 'mta',\n\t},\n" +
				// The same entry written with its `kind:` beside the brace: legal
				// TypeScript, invisible to the line anchor.
				"\t{ kind: 'postmark', label: 'Postmark' },\n",
		});
		const result = runIn(root);

		expect(result.output).toContain('could not read the send-provider kinds');
		expect(result.output).toContain('read 1 kind(s) out of 2 entr(y/ies)');
		expect(result.output).not.toContain('ok:');
		expect(result.status).toBe(1);
	});

	it('tolerates a trailing note on the declaration line, and still ratchets that kind', () => {
		// House style comments a new entry. A gate that fails on a comment is a
		// gate people route around, so the note is parsed past rather than tripped
		// over — and the kind it annotates is guarded like any other.
		const root = sandbox({
			files: { 'apps/api/convex/delivery/newKind.ts': leak("kind === 'postmark'") },
			rawEntries:
				"\t{\n\t\tkind: 'mta',\n\t},\n" + "\t{\n\t\tkind: 'postmark', // the new relay\n\t},\n",
		});
		const result = runIn(root);

		expect(result.output).not.toContain('could not read the send-provider kinds');
		expect(result.output).toContain('apps/api/convex/delivery/newKind.ts:2');
		expect(result.status).toBe(1);
	});
});
