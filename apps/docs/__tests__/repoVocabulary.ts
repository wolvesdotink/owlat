import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * THE NAMES THE REPOSITORY DECLARES, and the doc prose that cites them.
 *
 * `apps/docs/content` used to be pinned page by page: sixteen suites, ~5,400
 * lines, each one re-implementing "read this markdown, regex this paragraph,
 * assert the sentence still says what the code says" for one page. They cost
 * more than they caught — a page reworded for clarity broke a suite that named
 * a heading, while a constant renamed under a page nobody had written a suite
 * for drifted for months (`LEGAL_EDGES` and `ISP_PROFILES` were both cited by
 * the developer docs long after the code stopped declaring them).
 *
 * The replacement is one question asked of every page at once: a name written
 * in backticks is a claim that the repository declares that name, so collect
 * what the repository declares and check the claims. Which pages exist and how
 * they are worded stops mattering; only the names do.
 *
 * The universe is built from DECLARATION SITES, not from every token in the
 * tree: a `const`/`function`/`class`/`type`/`interface`/`enum` binding, an
 * `export { … }` list, an object or interface member, a Vue component's
 * auto-import name, a Java class or method, an environment variable declared in
 * an env example / compose file / shell script, and a SCREAMING_SNAKE string
 * literal (error and status codes are declared that way). A name found only in
 * a comment does NOT count — that is exactly how a citation of a deleted
 * constant stays green.
 */

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '../../..');

const SKIP_DIRS = new Set([
	'node_modules',
	'dist',
	'.nuxt',
	'.output',
	'.turbo',
	'.git',
	'coverage',
	'content',
]);

function walk(dir: string, matches: (path: string) => boolean, out: string[] = []): string[] {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (SKIP_DIRS.has(entry.name)) continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) walk(path, matches, out);
		else if (matches(path)) out.push(path);
	}
	return out;
}

/** Line and block comments, blanked so a name only a comment mentions is absent. */
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const ENV_DECLARATION_FILES = [
	'.env.example',
	'.env.selfhost.example',
	'apps/mta/.env.example',
	'infra/templates/.env.vps.template',
	'docker-compose.yml',
	'infra/templates/docker-compose.vps.yml',
];

function buildVocabulary(): ReadonlySet<string> {
	const names = new Set<string>();
	const add = (name: string | undefined) => {
		if (name) names.add(name);
	};

	const code = [
		...walk(join(REPO_ROOT, 'apps'), (p) => /\.(ts|vue)$/.test(p)),
		...walk(join(REPO_ROOT, 'packages'), (p) => /\.(ts|vue|java)$/.test(p)),
		...walk(join(REPO_ROOT, 'examples'), (p) => /\.ts$/.test(p)),
		...walk(join(REPO_ROOT, 'scripts'), (p) => /\.ts$/.test(p)),
	];
	for (const file of code) {
		const source = stripComments(readFileSync(file, 'utf8'));
		// Bindings, in both languages (`record` is Java's).
		for (const m of source.matchAll(
			/\b(?:const|let|function|class|type|interface|enum|record)\s+([A-Za-z_$][\w$]*)/g
		)) {
			add(m[1]);
		}
		// Re-export lists, taking the exported name of an `as` rename.
		for (const m of source.matchAll(/export\s*\{([^}]*)\}/g)) {
			for (const part of m[1]!.split(','))
				add(
					part
						.trim()
						.split(/\s+as\s+/)
						.pop()
						?.trim()
				);
		}
		// Object literal / interface / class members and method signatures.
		for (const m of source.matchAll(
			/^\s*(?:readonly\s+|public\s+|private\s+|protected\s+|static\s+|final\s+|async\s+)*([A-Za-z_$][\w$]*)\s*[?!]?\s*[:(]/gm
		)) {
			add(m[1]);
		}
		// Java methods, whose return type sits between the modifier and the name.
		if (file.endsWith('.java')) {
			for (const m of source.matchAll(
				/\b(?:public|protected|private)\s+(?:static\s+)?(?:final\s+)?[\w<>[\],.]+\s+([A-Za-z_$][\w$]*)\s*\(/g
			)) {
				add(m[1]);
			}
		}
		// Error / status codes, which are declared as SCREAMING_SNAKE literals.
		for (const m of source.matchAll(/['"]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)['"]/g)) add(m[1]);
		// Environment variables the code reads directly.
		for (const m of source.matchAll(
			/process\.env(?:\.([A-Z][A-Z0-9_]{2,})|\[['"]([A-Z][A-Z0-9_]{2,})['"]\])/g
		)) {
			add(m[1] ?? m[2]);
		}
	}

	// Nuxt auto-import names for the design-system components: the docs cite
	// `UiButton`, the file is packages/ui/components/ui/Button.vue.
	for (const file of walk(join(REPO_ROOT, 'packages/ui/components'), (p) => p.endsWith('.vue'))) {
		const base = file.slice(file.lastIndexOf('/') + 1, -'.vue'.length);
		add(base);
		add(`Ui${base}`);
	}

	// Shell variables: the installer and the CLI wrapper are pure bash.
	for (const file of [
		...walk(join(REPO_ROOT, 'scripts'), (p) => p.endsWith('.sh')),
		join(REPO_ROOT, 'install.sh'),
		join(REPO_ROOT, 'scripts/owlat'),
	]) {
		let source: string;
		try {
			source = readFileSync(file, 'utf8');
		} catch {
			continue;
		}
		for (const m of source.matchAll(/\b([A-Z][A-Z0-9_]{2,})=/g)) add(m[1]);
		for (const m of source.matchAll(/\$\{?([A-Z][A-Z0-9_]{2,})/g)) add(m[1]);
	}

	for (const file of ENV_DECLARATION_FILES) {
		const source = readFileSync(resolve(REPO_ROOT, file), 'utf8');
		for (const m of source.matchAll(/^#?\s*([A-Z][A-Z0-9_]{2,})[=:]/gm)) add(m[1]);
		for (const m of source.matchAll(/\$\{([A-Z][A-Z0-9_]{2,})/g)) add(m[1]);
	}

	return names;
}

let cached: ReadonlySet<string> | undefined;

/** Every name the repository declares. Built once per process. */
export function repoVocabulary(): ReadonlySet<string> {
	cached ??= buildVocabulary();
	return cached;
}

export interface DocPage {
	/** Repo-relative path, for the failure message. */
	readonly path: string;
	/** Page body with fenced code blocks removed. */
	readonly prose: string;
}

/**
 * Every documentation page, prose only.
 *
 * Fenced blocks are dropped: a sample is illustrative code that names
 * variables, third-party APIs and placeholder values that the repository has no
 * reason to declare. A claim about THIS codebase is made in the prose.
 */
export function docPages(): DocPage[] {
	return walk(join(REPO_ROOT, 'apps/docs/content'), (p) => p.endsWith('.md')).map((file) => ({
		path: file.slice(REPO_ROOT.length + 1),
		prose: readFileSync(file, 'utf8').replace(/^```[\s\S]*?^```/gm, ''),
	}));
}

/** Every `` `token` `` in a page body, de-duplicated, in first-seen order. */
export function backtickSpans(prose: string): string[] {
	return [...new Set([...prose.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!))];
}
