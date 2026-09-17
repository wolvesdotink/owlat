import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * Nitro server routes talk to Convex through a `ConvexHttpClient`, and that
 * client can only address the deployment's PUBLIC function surface. An
 * `internal*` function is not reachable from it at all — Convex answers
 * "Could not find public function for '<module>:<fn>'" and the route 500s.
 *
 * Nothing in the type system says so. `internal.foo.bar` is a
 * `FunctionReference<'mutation', 'internal'>`, which the client's signature
 * rejects — so the one place this went wrong cast it to a public reference to
 * make it compile, and `POST /api/system/update` answered 500 for every
 * operator who pressed "Update now" until someone read the container logs.
 * Public and internal references are also indistinguishable at runtime (both
 * stringify to `module:fn`), so no unit test of a route can catch it either.
 *
 * Hence a static check: no file under `server/` may import `internal` from
 * `@owlat/api`. Server-side work that genuinely needs an internal function
 * belongs behind a gated public function, or a Convex HTTP action.
 */

const SERVER_ROOT = resolve(import.meta.dirname, '..');

function serverSourceFiles(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
			found.push(...serverSourceFiles(path));
		} else if (entry.name.endsWith('.ts')) {
			found.push(path);
		}
	}
	return found;
}

describe('Convex function visibility in Nitro routes', () => {
	it('never imports `internal` from @owlat/api under server/', () => {
		const offenders = serverSourceFiles(SERVER_ROOT)
			.filter((file) => {
				const source = readFileSync(file, 'utf-8');
				const imports = source.match(/import\s+(?:type\s+)?\{[^}]*\}\s+from\s+'@owlat\/api'/g);
				return (imports ?? []).some((statement) => /\binternal\b/.test(statement));
			})
			.map((file) => relative(SERVER_ROOT, file));

		expect(offenders).toEqual([]);
	});

	it('finds the files it is scanning (guards the walker itself)', () => {
		const files = serverSourceFiles(SERVER_ROOT).map((file) => relative(SERVER_ROOT, file));
		expect(files).toContain(join('api', 'system', 'update.post.ts'));
		expect(files.length).toBeGreaterThan(20);
	});
});
