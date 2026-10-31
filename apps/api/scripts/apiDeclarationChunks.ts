/**
 * `convex/_generated/api.d.ts` declares `fullApi` as an intersection of
 * `ApiFromModules<{...}>` chunks, one per top-level directory, instead of the
 * single `ApiFromModules` over every module that `convex codegen` writes.
 *
 * `ApiFromModules` folds the module map with `UnionToIntersection`, and
 * TypeScript checks that fold as one assignability relation whose cost grows
 * with the square of the module count (about 0.54 * n^2 relation steps). One
 * relation gets a budget of (16M - relations already cached) / 8, at most 2M
 * steps. A single map of ~1,930 modules needs ~2M: past that point TypeScript
 * gives up, records the "Excessive complexity" error against `api.d.ts`
 * (hidden by `skipLibCheck`), and `api` and `internal` silently become
 * `never`. The bigger the program (apps/web pulls the whole backend in), the
 * less budget is left when `fullApi` is first resolved. Chunks keep each fold
 * small; `ApiFromModules` results for different directories merge cleanly
 * under `&`, so the property paths and function reference types are the same.
 *
 * The chunks are deterministic: a module's chunk follows from its own path,
 * and a directory larger than `MAX_MODULES_PER_CHUNK` is split by its
 * subdirectories. Entry order inside a chunk is kept, so hand-added entries
 * stay where they were put within their directory's chunk.
 */

/** ~0.54 * 500^2 = 135k relation steps per chunk, well inside the 2M budget. */
export const MAX_MODULES_PER_CHUNK = 500;

export const FULL_API_COMMENT = [
	'// One ApiFromModules chunk per top-level directory: a single map over every module',
	"// exceeds TypeScript's relation budget and turns api/internal into never.",
	'// Regenerate with `bun run --cwd apps/api codegen:chunks` (scripts/apiDeclarationChunks.ts).',
];

const DECLARATION_START = 'declare const fullApi: ApiFromModules<{';
const CHUNK_SEPARATOR = /^\s*\}>\s*&\s*ApiFromModules<\{\s*$/;
const DECLARATION_END = /^\s*\}>;\s*$/;
// Keys may be quoted either way, or bare when the path is an identifier.
const ENTRY = /^\s*(['"]?)([\w$/.-]+)\1\s*:\s*typeof\s+([A-Za-z_$][\w$]*)\s*[;,]?\s*$/;

interface Entry {
	path: string;
	segments: string[];
	line: string;
}

function chunkKey(entry: Entry, depth: number): string {
	// A module that sits directly in the directory being split forms its own chunk.
	return entry.segments.length > depth + 1 ? (entry.segments[depth] ?? '') : '';
}

function partition(entries: Entry[], depth: number): Entry[][] {
	const groups = new Map<string, Entry[]>();
	for (const entry of entries) {
		const key = chunkKey(entry, depth);
		const group = groups.get(key);
		if (group) group.push(entry);
		else groups.set(key, [entry]);
	}
	const chunks: Entry[][] = [];
	for (const key of [...groups.keys()].sort()) {
		const group = groups.get(key) ?? [];
		if (group.length <= MAX_MODULES_PER_CHUNK) {
			chunks.push(group);
		} else if (key === '') {
			// Modules directly in one directory cannot be split by subdirectory.
			for (let start = 0; start < group.length; start += MAX_MODULES_PER_CHUNK) {
				chunks.push(group.slice(start, start + MAX_MODULES_PER_CHUNK));
			}
		} else {
			chunks.push(...partition(group, depth + 1));
		}
	}
	return chunks;
}

/**
 * Rewrites the `fullApi` declaration of a generated `api.d.ts` into chunks and
 * leaves every other line untouched. Accepts both the monolithic form that
 * `convex codegen` writes and an already chunked file; the result is stable
 * under a second run.
 */
export function chunkApiDeclaration(source: string): string {
	const lines = source.split('\n');
	const start = lines.findIndex((line) => line.trimEnd() === DECLARATION_START);
	if (start === -1) {
		throw new Error(`api.d.ts has no \`${DECLARATION_START}\` line`);
	}
	const entries: Entry[] = [];
	const seen = new Set<string>();
	let end = -1;
	for (let index = start + 1; index < lines.length; index++) {
		const line = lines[index] ?? '';
		if (DECLARATION_END.test(line)) {
			end = index;
			break;
		}
		if (CHUNK_SEPARATOR.test(line) || line.trim() === '') continue;
		const match = ENTRY.exec(line);
		if (!match) {
			throw new Error(`api.d.ts line ${index + 1} is not a fullApi module entry: ${line}`);
		}
		const [, quote, path, alias] = match as unknown as [string, string, string, string];
		if (seen.has(path)) {
			throw new Error(`api.d.ts maps module '${path}' twice`);
		}
		seen.add(path);
		entries.push({
			path,
			segments: path.split('/'),
			line: `\t${quote}${path}${quote}: typeof ${alias};`,
		});
	}
	if (end === -1) {
		throw new Error('api.d.ts fullApi declaration has no closing `}>;` line');
	}

	let commentStart = start;
	while (commentStart > 0 && FULL_API_COMMENT.includes(lines[commentStart - 1] ?? '')) {
		commentStart--;
	}

	const chunks = entries.length === 0 ? [[]] : partition(entries, 0);
	const declaration = [
		...FULL_API_COMMENT,
		DECLARATION_START,
		...chunks.flatMap((chunk, index) => [
			...(index === 0 ? [] : ['}> & ApiFromModules<{']),
			...chunk.map((entry) => entry.line),
		]),
		'}>;',
	];
	return [...lines.slice(0, commentStart), ...declaration, ...lines.slice(end + 1)].join('\n');
}
