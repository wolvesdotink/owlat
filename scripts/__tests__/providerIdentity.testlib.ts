/**
 * Shared fixture for the provider-identity ratchet's own tests
 * (check-provider-identity*.test.ts).
 *
 * `sandbox()` builds a miniature repository — the real script, a written
 * allowlist and collisions list, a catalog to parse, and whatever source files
 * the case seeds — so a case can prove what the gate does with a violation
 * without touching the repository the gate guards.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const SCRIPT = resolve(import.meta.dirname, '../check-provider-identity.sh');
export const ALLOWLIST = resolve(import.meta.dirname, '../provider-identity-allowlist.txt');
export const COLLISIONS = resolve(import.meta.dirname, '../provider-identity-collisions.txt');
export const REPO_ROOT = resolve(import.meta.dirname, '../..');

export const DEFAULT_KINDS = ['mta', 'ses', 'resend', 'smtp', 'mandrill'];

export type Result = { status: number; output: string };

export function runIn(root: string): Result {
	const run = spawnSync('bash', [join(root, 'scripts/check-provider-identity.sh')], {
		cwd: root,
		encoding: 'utf8',
	});
	return { status: run.status ?? -1, output: `${run.stdout}${run.stderr}` };
}

const sandboxes: string[] = [];

/** Register with `afterEach` in every file that calls `sandbox()`. */
export function cleanupSandboxes(): void {
	while (sandboxes.length > 0) {
		const dir = sandboxes.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * A miniature repository: the real script, a written allowlist, a kind
 * declaration for it to parse, and whatever source files the case seeds. The
 * script reads `git ls-files`, so the tree is staged.
 */
export function sandbox(options: {
	files: Record<string, string>;
	allowlist?: string[];
	collisions?: string[];
	kinds?: string[] | null;
	/**
	 * Give each entry a nested credential-field descriptor, which has a `kind:`
	 * of its own one level deeper — the shape the real catalog has since P1.1.
	 */
	withCredentialFields?: boolean;
	/**
	 * The catalog entries verbatim, for the cases that are ABOUT the parse: the
	 * text between `const CORE_SEND_PROVIDER_CATALOG = [` and the `satisfies`
	 * that closes it. Overrides `kinds`.
	 */
	rawEntries?: string;
}): string {
	const root = mkdtempSync(join(tmpdir(), 'owlat-provider-identity-'));
	sandboxes.push(root);

	mkdirSync(join(root, 'scripts'), { recursive: true });
	copyFileSync(SCRIPT, join(root, 'scripts/check-provider-identity.sh'));
	writeFileSync(
		join(root, 'scripts/provider-identity-allowlist.txt'),
		`# sandbox allowlist\n${(options.allowlist ?? []).join('\n')}\n`
	);
	writeFileSync(
		join(root, 'scripts/provider-identity-collisions.txt'),
		`# sandbox collisions\n${(options.collisions ?? []).join('\n')}\n`
	);

	const kinds = options.kinds === undefined ? DEFAULT_KINDS : options.kinds;
	if (options.rawEntries !== undefined || kinds !== null) {
		// The catalog literal, as the script parses it: entry `kind:` at two tabs,
		// bounded by the const declaration and the `satisfies` that closes it.
		const fields = options.withCredentialFields
			? "\t\tcredentialFields: [{ kind: 'secret', envVar: 'X' }],\n"
			: '';
		const entries =
			options.rawEntries ??
			(kinds ?? []).map((k) => `\t{\n\t\tkind: '${k}',\n${fields}\t},\n`).join('');
		write(
			root,
			'packages/shared/src/sendProviderCatalogData.ts',
			`export const CORE_SEND_PROVIDER_CATALOG = [\n${entries}] as const satisfies readonly CoreSendProviderCatalogEntry[];\n`
		);
	}

	for (const [path, contents] of Object.entries(options.files)) write(root, path, contents);

	execFileSync('git', ['init', '--quiet'], { cwd: root });
	execFileSync('git', ['add', '--all'], { cwd: root });
	return root;
}

export function write(root: string, path: string, contents: string): void {
	const absolute = join(root, path);
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, contents);
}

/** A file whose only interesting property is the comparison it makes. */
export function leak(comparison: string): string {
	return `export function decide(kind: string): boolean {\n\treturn ${comparison};\n}\n`;
}

export type ListEntry = { raw: string; path: string; literal?: string; block: string };

/**
 * The list format the script reads: `# ── block header ──` lines, then entries
 * as `path` or `path:literal`, each optionally carrying a trailing `#` note.
 */
export function parseList(contents: string): ListEntry[] {
	const entries: ListEntry[] = [];
	let block = '';
	for (const line of contents.split('\n')) {
		const header = /^#\s*──\s*(.+?)\s*─+\s*$/.exec(line);
		if (header) {
			block = header[1] ?? '';
			continue;
		}
		const trimmed = line.trim();
		if (trimmed === '' || trimmed.startsWith('#')) continue;
		const raw = trimmed.replace(/\s+#.*$/, '').trim();
		const [path, literal] = raw.split(':');
		entries.push({ raw, path: path ?? raw, literal, block });
	}
	return entries;
}
