import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Internal notes never leave Owlat. Nothing that sends mail, quotes a reply,
 * forwards, exports a contact's data, fires a webhook or builds an agent or
 * assistant prompt may read them, and the simplest way to keep that true is to
 * keep the set of modules that touch the note tables small and known.
 *
 * Every non-test module under `convex/` that names `threadNotes` or
 * `threadNoteMentions` must be on this list. A new reader fails here, and
 * whoever adds it has to say why the notes may go there.
 */
const ALLOWED = new Set([
	// The feature itself.
	'inbox/notes.ts',
	'inbox/noteMentions.ts',
	'inbox/noteRules.ts',
	'schema/inboxCollaboration.ts',
	// The author's own account export (not the contact's data export).
	'auth/accountExport.ts',
	'auth/accountExportQueries.ts',
	// Data lifecycle: member erasure, contact erasure, workspace deletion.
	'auth/erasure/memberPhases.ts',
	'auth/erasure/phases.ts',
	'auth/erasure/relations.ts',
	'contacts/erasure/contentPhases.ts',
	'contacts/erasure/relations.ts',
	'lib/tenantTables.ts',
	'workspaces/deletion/steps/_common.ts',
	'workspaces/deletion/steps/cascadeOrder.ts',
	'workspaces/deletion/steps/registry.ts',
]);

const ROOT = join(__dirname, '..', '..');
const SKIP_DIRS = new Set(['__tests__', '_generated', 'node_modules']);

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			if (!SKIP_DIRS.has(name)) out.push(...sourceFiles(path));
		} else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
			out.push(path);
		}
	}
	return out;
}

describe('internal notes stay internal', () => {
	it('only the known modules touch the note tables', () => {
		const readers = sourceFiles(ROOT)
			.filter((path) => /\bthreadNote(s|Mentions)\b/.test(readFileSync(path, 'utf8')))
			.map((path) => relative(ROOT, path).split('\\').join('/'))
			.sort();
		expect(readers.filter((path) => !ALLOWED.has(path))).toEqual([]);
		// The list must not go stale either: every entry still touches them.
		expect([...ALLOWED].filter((path) => !readers.includes(path))).toEqual([]);
	});
});
