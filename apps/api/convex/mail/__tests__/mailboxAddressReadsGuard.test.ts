/**
 * Source-scan guard: `mailboxes` rows are read by address only through
 * `mail/mailbox/addressResolution.ts`.
 *
 * One address can carry several rows (a move's external archive beside its
 * hosted successor, a disconnected mailbox kept for reconnect, a removed hosted
 * mailbox), so a bare `by_address` read answers "which mailbox is this" with
 * whichever row is oldest. That module names the three questions a caller can
 * actually ask (`resolveDeliverableMailbox`, `findAddressClaim`,
 * `listMailboxesOnAddress`); this test fails when a new file reads the index
 * inline instead.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONVEX_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** The one module allowed to read `mailboxes` through `by_address`. */
const ALLOWED = new Set(['mail/mailbox/addressResolution.ts']);

/** How many lines after `query('mailboxes')` the `withIndex` may sit. */
const WINDOW = 3;

const MAILBOXES_QUERY = /query\(\s*['"]mailboxes['"]\s*\)/;
const BY_ADDRESS_INDEX = /withIndex\(\s*['"]by_address['"]/;
const NEXT_QUERY = /\bquery\(/;

function sourceFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === '_generated' || entry.name === '__tests__') continue;
		if (entry.name === 'node_modules') continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...sourceFiles(path));
		else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) files.push(path);
	}
	return files;
}

/** `file:line` for every `mailboxes` query that reaches `by_address` within the window. */
function findInlineAddressReads(file: string, source: string): string[] {
	const lines = source.split('\n');
	const hits: string[] = [];
	for (const [i, line] of lines.entries()) {
		const match = MAILBOXES_QUERY.exec(line);
		if (!match) continue;
		// The chain after this query, up to the next query that starts.
		const rest = [line.slice(match.index + match[0].length), ...lines.slice(i + 1, i + WINDOW + 1)]
			.join('\n')
			.split(NEXT_QUERY)[0];
		if (rest !== undefined && BY_ADDRESS_INDEX.test(rest)) hits.push(`${file}:${i + 1}`);
	}
	return hits;
}

describe('mailboxes by_address reads', () => {
	it('detects an inline read, on one line or split across the next lines', () => {
		expect(
			findInlineAddressReads(
				'x.ts',
				[
					"const a = await ctx.db.query('mailboxes').withIndex('by_address', (q) => q);",
					'const b = await ctx.db',
					"\t.query('mailboxes')",
					"\t.withIndex('by_address', (q) => q.eq('address', address))",
					"const c = await ctx.db.query('mailboxes').withIndex('by_user', (q) => q);",
					"const d = await ctx.db.query('mailKeys').withIndex('by_address', (q) => q);",
				].join('\n')
			)
		).toEqual(['x.ts:1', 'x.ts:3']);
	});

	it('happen only in mail/mailbox/addressResolution.ts', () => {
		const offenders = sourceFiles(CONVEX_ROOT).flatMap((path) => {
			const file = relative(CONVEX_ROOT, path).split('\\').join('/');
			if (ALLOWED.has(file)) return [];
			return findInlineAddressReads(file, readFileSync(path, 'utf8'));
		});
		expect(
			offenders,
			'Read mailboxes by address through mail/mailbox/addressResolution.ts ' +
				'(resolveDeliverableMailbox, findAddressClaim or listMailboxesOnAddress).'
		).toEqual([]);
	});

	it('still sees the allowed module, so the scan is not reading an empty tree', () => {
		const source = readFileSync(join(CONVEX_ROOT, 'mail/mailbox/addressResolution.ts'), 'utf8');
		expect(findInlineAddressReads('addressResolution.ts', source)).toHaveLength(1);
	});
});
