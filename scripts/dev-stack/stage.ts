/**
 * The Convex project the dev stack pushes from: a mirror of `apps/api` without
 * its `__tests__` directories.
 *
 * Pushing `apps/api` itself fails. The Convex CLI treats every single-dot
 * `.ts` file under `convex/` as a function module, so test helpers such as
 * `convex/__tests__/testModules.ts` (Vite's `import.meta.glob`) and the
 * `node:fs` fixtures get bundled for the V8 runtime and the push aborts. The
 * deploy image drops the same directories for the same reason
 * (`docker/convex-deploy.Dockerfile`), so the stage pushes what production
 * deploys. Its `_generated/` is the committed one: the push runs with codegen
 * off, so a push never rewrites tracked files. `bun run dev:stack codegen`
 * runs codegen in the stage and copies the output back
 * (`copyGeneratedBack`).
 *
 * The stage sits two levels below the repository root, like `apps/api`, so
 * package resolution walks up to the same root `node_modules`.
 */

import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	watch,
	type FSWatcher,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';

/** What the stage mirrors, relative to `apps/api`. */
const MIRRORED = ['package.json', 'convex'] as const;
const EXCLUDED_DIRS = new Set(['__tests__', 'node_modules']);
/** Files the CLI and the stack write into the stage itself. */
const STAGE_OWNED = new Set(['.env.local']);

export interface SyncResult {
	readonly copied: number;
	readonly removed: number;
}

function isExcluded(relPath: string): boolean {
	return relPath.split(sep).some((part) => EXCLUDED_DIRS.has(part));
}

function collect(srcRoot: string, rel: string, out: Map<string, number>): void {
	const abs = join(srcRoot, rel);
	const stat = statSync(abs, { throwIfNoEntry: false });
	if (!stat) return;
	if (stat.isDirectory()) {
		for (const entry of readdirSync(abs)) {
			const child = join(rel, entry);
			if (!isExcluded(child)) collect(srcRoot, child, out);
		}
		return;
	}
	if (stat.isFile()) out.set(rel, stat.mtimeMs);
}

function removeStale(stageRoot: string, rel: string, keep: Map<string, number>): number {
	const abs = join(stageRoot, rel);
	const stat = lstatSync(abs, { throwIfNoEntry: false });
	if (!stat) return 0;
	if (stat.isDirectory()) {
		let removed = 0;
		for (const entry of readdirSync(abs)) removed += removeStale(stageRoot, join(rel, entry), keep);
		if (readdirSync(abs).length === 0 && rel !== '') rmSync(abs, { recursive: true });
		return removed;
	}
	if (keep.has(rel) || (rel !== '' && STAGE_OWNED.has(rel))) return 0;
	rmSync(abs, { force: true });
	return 1;
}

/**
 * Brings `stageRoot` in line with `apiRoot`: copies new or changed files
 * (size or mtime differ), deletes what no longer exists in the source, and
 * never touches the stage-owned `.env.local`. Running it twice in a row
 * copies nothing the second time.
 */
export function syncStage(apiRoot: string, stageRoot: string): SyncResult {
	const files = new Map<string, number>();
	for (const entry of MIRRORED) collect(apiRoot, entry, files);
	if (!files.has('package.json')) {
		throw new Error(`${apiRoot} has no package.json; is this the apps/api directory?`);
	}
	mkdirSync(stageRoot, { recursive: true });
	let copied = 0;
	for (const [rel, mtimeMs] of files) {
		const src = join(apiRoot, rel);
		const dest = join(stageRoot, rel);
		const existing = statSync(dest, { throwIfNoEntry: false });
		const srcSize = statSync(src).size;
		// Copies carry the source mtime, but not every filesystem keeps it to the
		// sub-millisecond, so "unchanged" allows for that rounding.
		if (
			existing?.isFile() &&
			Math.abs(existing.mtimeMs - mtimeMs) < 1 &&
			existing.size === srcSize
		) {
			continue;
		}
		if (existing?.isDirectory()) rmSync(dest, { recursive: true });
		mkdirSync(dirname(dest), { recursive: true });
		copyFileSync(src, dest);
		utimesSync(dest, mtimeMs / 1000, mtimeMs / 1000);
		copied += 1;
	}
	let removed = 0;
	if (existsSync(stageRoot)) {
		for (const entry of readdirSync(stageRoot)) removed += removeStale(stageRoot, entry, files);
	}
	return { copied, removed };
}

function generatedFiles(root: string, rel: string, inGenerated: boolean, out: string[]): void {
	const abs = join(root, rel);
	const stat = statSync(abs, { throwIfNoEntry: false });
	if (!stat) return;
	if (stat.isDirectory()) {
		for (const entry of readdirSync(abs)) {
			const child = join(rel, entry);
			if (!isExcluded(child)) {
				generatedFiles(root, child, inGenerated || entry === '_generated', out);
			}
		}
		return;
	}
	if (stat.isFile() && inGenerated) out.push(rel);
}

/**
 * Copies what `convex codegen` wrote into the stage's `_generated/`
 * directories (the app's and each local component's) back into `apiRoot`, so
 * the checkout holds the output. Only files whose bytes differ are written,
 * with the stage file's mtime, so the next `syncStage` copies nothing back.
 * Returns how many files changed.
 */
export function copyGeneratedBack(stageRoot: string, apiRoot: string): number {
	const files: string[] = [];
	generatedFiles(stageRoot, 'convex', false, files);
	let changed = 0;
	for (const rel of files) {
		const src = join(stageRoot, rel);
		const dest = join(apiRoot, rel);
		const content = readFileSync(src);
		const existing = statSync(dest, { throwIfNoEntry: false });
		if (existing?.isFile() && readFileSync(dest).equals(content)) continue;
		mkdirSync(dirname(dest), { recursive: true });
		copyFileSync(src, dest);
		const { mtime } = statSync(src);
		utimesSync(dest, mtime, mtime);
		changed += 1;
	}
	return changed;
}

/**
 * Re-syncs the stage whenever something under `apps/api/convex` or its
 * package.json changes, debounced so a branch switch is one sync, not
 * hundreds. The Convex CLI watching the stage then pushes as usual.
 */
export function watchStage(
	apiRoot: string,
	stageRoot: string,
	onSync: (result: SyncResult | Error) => void,
	debounceMs = 150
): () => void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const schedule = (changed: string | null) => {
		if (changed && isExcluded(changed)) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			try {
				onSync(syncStage(apiRoot, stageRoot));
			} catch (error) {
				onSync(error instanceof Error ? error : new Error(String(error)));
			}
		}, debounceMs);
	};
	const watchers: FSWatcher[] = [
		watch(join(apiRoot, 'convex'), { recursive: true }, (_event, file) =>
			schedule(file ? String(file) : null)
		),
		watch(join(apiRoot, 'package.json'), () => schedule(null)),
	];
	return () => {
		if (timer) clearTimeout(timer);
		for (const watcher of watchers) watcher.close();
	};
}
