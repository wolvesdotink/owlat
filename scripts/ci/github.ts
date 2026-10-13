import { execFileSync } from 'node:child_process';
function apiOutput(path: string, paginate = false): string {
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			return execFileSync('gh', ['api', path, ...(paginate ? ['--paginate'] : [])], {
				encoding: 'utf8',
				maxBuffer: 64 * 1024 * 1024,
				timeout: 60_000,
				stdio: ['ignore', 'pipe', 'pipe'],
			});
		} catch (error) {
			if (attempt === 2 || !isTransientAPIError(String(error))) throw error;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000 * (attempt + 1));
		}
	}
	throw new Error('GitHub API retry budget exhausted');
}
export function isTransientAPIError(message: string) {
	return /HTTP (?:5\d\d|429)|ETIMEDOUT|ECONNRESET/.test(message);
}
export function github<T>(path: string): T {
	return JSON.parse(apiOutput(path)) as T;
}

// gh --paginate prints concatenated JSON documents. Avoid --slurp, which is
// unavailable on older developer CLIs, while retaining API Link pagination.
export function jsonPages(text: string): unknown[] {
	const pages: unknown[] = [];
	let depth = 0,
		start = -1,
		quoted = false,
		escaped = false;
	for (let i = 0; i < text.length; i++) {
		const char = text[i]!;
		if (start < 0) {
			if (/\s/.test(char)) continue;
			if (char !== '[' && char !== '{') throw new Error('Invalid paginated JSON');
			start = i;
		}
		if (quoted) {
			if (escaped) escaped = false;
			else if (char === '\\') escaped = true;
			else if (char === '"') quoted = false;
			continue;
		}
		if (char === '"') quoted = true;
		else if (char === '[' || char === '{') depth++;
		else if (char === ']' || char === '}') {
			if (--depth === 0) {
				pages.push(JSON.parse(text.slice(start, i + 1)));
				start = -1;
			}
		}
	}
	if (start >= 0 || !pages.length) throw new Error('Incomplete paginated JSON');
	return pages;
}
export function githubPages<T>(path: string): T[] {
	return jsonPages(apiOutput(path, true)).flat() as T[];
}
export function repository(): string {
	const repo =
		process.env['GITHUB_REPOSITORY'] ??
		execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], {
			encoding: 'utf8',
		}).trim();
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Invalid repository');
	return repo;
}
