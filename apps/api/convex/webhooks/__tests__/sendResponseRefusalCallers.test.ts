/**
 * Every caller of `sendProviderDispatch` mirrors a send-response refusal (#1243).
 *
 * A provider can refuse an address off its own reject list in the send
 * response. The Mandrill webhook drops a later out-of-scope `reject` that
 * matches no Send on the strength of that mirror, so a caller that dispatches
 * and ignores `result.suppression` would let the address stay mailable. This
 * walks the backend and fails a module that imports `sendProviderDispatch` without
 * also calling `recordSendResponseRefusal`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const CONVEX_ROOT = join(__dirname, '..', '..');
const SKIPPED_DIRS = new Set(['__tests__', '_generated', 'node_modules']);
/** An import of the dispatcher, which is what a caller needs (comments that name it do not). */
const DISPATCH_IMPORT =
	/import\s*\{[^}]*\bsendProviderDispatch\b[^}]*\}\s*from\s*'[^']*sendProviders\/dispatch'/;

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return SKIPPED_DIRS.has(name) ? [] : sourceFiles(path);
		return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
	});
}

describe('send-response refusal callers', () => {
	const callers = sourceFiles(CONVEX_ROOT)
		.filter((path) => DISPATCH_IMPORT.test(readFileSync(path, 'utf8')))
		.map((path) => relative(CONVEX_ROOT, path));

	it('finds the known callers', () => {
		expect(callers.sort()).toEqual([join('delivery', 'governedDispatch.ts'), 'systemMail.ts']);
	});

	it.each(callers)('%s mirrors the refusal', (path) => {
		expect(readFileSync(join(CONVEX_ROOT, path), 'utf8')).toMatch(/\brecordSendResponseRefusal\(/);
	});
});
