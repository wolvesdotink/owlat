/**
 * Side-by-side comparison of the text-matching boundary gates and the oxlint
 * rules that replace them (packages/oxlint-plugin-owlat). Both run for one
 * release; this runner diffs their findings per rule so the old gate can only
 * be retired on evidence:
 *
 *   gate                                   rule
 *   scripts/check-crypto-primitives.sh     owlat/no-crypto-primitives
 *   apps/api/scripts/check-env.sh          owlat/no-process-env
 *   apps/api/scripts/check-log-pii.sh      owlat/no-log-pii
 *   apps/api/scripts/check-errors.sh       owlat/convex-error-taxonomy
 *   apps/api/scripts/check-public-functions.sh  owlat/no-raw-convex-builder
 *   apps/api/scripts/check-session-threading.sh owlat/use-threaded-session
 *   apps/api/scripts/check-feature-floors.sh    owlat/feature-floor-in-builder
 *
 * Findings are normalized to a site: `path:line` for the per-line gates and
 * `path:function` for the two per-function ones, with repository-relative
 * paths. Every site only one side reports must be listed in KNOWN_DIFFERENCES
 * with the reason the two disagree (a grep reading a comment, a spelling the
 * grep cannot see); anything else fails, in both directions.
 *
 *   bun scripts/ast-gate-parity.ts            compare on this repository
 *   bun scripts/ast-gate-parity.ts --root D   compare on another tree with the
 *                                             same layout (the parity tests)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { type LintDiagnostic, parseLintReport } from './lint-diagnostics';

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
// The package's launcher, run by its own `node` shebang: under bun's runtime
// its JSON output can be cut short at exit.
const OXLINT = join(REPOSITORY_ROOT, 'node_modules/.bin/oxlint');

export type GateName =
	| 'crypto'
	| 'env'
	| 'log-pii'
	| 'errors'
	| 'public-functions'
	| 'session-threading'
	| 'feature-floors';

interface Gate {
	readonly name: GateName;
	readonly rule: string;
	/** The old gate, repository-relative. */
	readonly script: string;
	readonly args: readonly string[];
	/** The old gate prints `path:function` sites rather than `path:line`. */
	readonly perFunction: boolean;
	/** The directory, repository-relative, that the old gate's paths are relative to. */
	readonly base: string;
}

export const GATES: readonly Gate[] = [
	{
		name: 'crypto',
		rule: 'no-crypto-primitives',
		script: 'scripts/check-crypto-primitives.sh',
		args: ['--generate'],
		base: '',
		perFunction: false,
	},
	{
		name: 'env',
		rule: 'no-process-env',
		script: 'apps/api/scripts/check-env.sh',
		args: [],
		base: 'apps/api/convex/',
		perFunction: false,
	},
	{
		name: 'log-pii',
		rule: 'no-log-pii',
		script: 'apps/api/scripts/check-log-pii.sh',
		args: [],
		base: 'apps/api/',
		perFunction: false,
	},
	{
		name: 'errors',
		rule: 'convex-error-taxonomy',
		script: 'apps/api/scripts/check-errors.sh',
		args: [],
		base: 'apps/api/',
		perFunction: false,
	},
	{
		name: 'public-functions',
		rule: 'no-raw-convex-builder',
		script: 'apps/api/scripts/check-public-functions.sh',
		args: [],
		base: 'apps/api/',
		perFunction: false,
	},
	{
		name: 'session-threading',
		rule: 'use-threaded-session',
		script: 'apps/api/scripts/check-session-threading.sh',
		args: ['--generate'],
		base: 'apps/api/',
		perFunction: true,
	},
	{
		name: 'feature-floors',
		rule: 'feature-floor-in-builder',
		script: 'apps/api/scripts/check-feature-floors.sh',
		args: ['--generate'],
		base: 'apps/api/',
		perFunction: true,
	},
];

export interface KnownDifference {
	readonly gate: GateName;
	readonly site: string;
	/** `old`: only the text gate reports it; `new`: only the rule does. */
	readonly side: 'old' | 'new';
	readonly reason: string;
}

/** Every site on this repository where the two sides disagree, and why. */
export const KNOWN_DIFFERENCES: readonly KnownDifference[] = [];

export interface Comparison {
	readonly gate: GateName;
	readonly old: readonly string[];
	readonly new: readonly string[];
	readonly onlyOld: readonly string[];
	readonly onlyNew: readonly string[];
}

const sorted = (values: Iterable<string>): string[] =>
	[...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** The old gate's sites. A non-0/1 exit, or a crash, throws. */
export function oldFindings(root: string, gate: Gate): string[] {
	const run = spawnSync('bash', [gate.script, ...gate.args], {
		cwd: root,
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
	});
	if (run.error || (run.status !== 0 && run.status !== 1)) {
		throw new Error(`${gate.script} exited ${String(run.status)}: ${run.stderr}`);
	}
	const sites: string[] = [];
	for (const line of run.stdout.split('\n')) {
		const match = gate.perFunction
			? /^(\S+\.ts):([A-Za-z0-9_$<>]+)$/.exec(line.trim())
			: /^\s*(\S+?\.[a-z]+):(\d+):/.exec(line);
		if (match) sites.push(`${gate.base}${match[1]}:${match[2]}`);
	}
	if (gate.name === 'crypto') {
		// `--generate` lists the sanctioned modules' own hits too; the gate skips them.
		const script = readFileSync(join(root, gate.script), 'utf8');
		const allowed = [...script.matchAll(/^\s*\['([^']+)'\]=/gm)].map((match) => match[1]);
		return sorted(sites.filter((site) => !allowed.some((path) => site.startsWith(`${path}:`))));
	}
	return sorted(sites);
}

/** One oxlint run with the repository config over `root`'s apps/ and packages/. */
export function lintDiagnostics(root: string): LintDiagnostic[] {
	const targets = ['apps', 'packages'].filter((directory) => existsSync(join(root, directory)));
	const run = spawnSync(
		OXLINT,
		['--config', join(REPOSITORY_ROOT, 'oxlintrc.json'), '--format', 'json', ...targets],
		{ cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
	);
	if (run.error || (run.status !== 0 && run.status !== 1)) {
		throw new Error(`oxlint exited ${String(run.status)}: ${run.stderr}`);
	}
	return parseLintReport(run.stdout);
}

/** The `allow` sites of owlat/feature-floor-in-builder in the repository config. */
export function featureFloorAllowances(): string[] {
	const text = readFileSync(join(REPOSITORY_ROOT, 'oxlintrc.json'), 'utf8');
	const { config, error } = ts.parseConfigFileTextToJson('oxlintrc.json', text);
	if (error) throw new Error('oxlintrc.json does not parse');
	const entry = (config as { rules: Record<string, unknown> }).rules[
		'owlat/feature-floor-in-builder'
	] as [string, { allow?: { sites: string[] }[] }];
	return (entry[1].allow ?? []).flatMap(({ sites }) => sites);
}

const FUNCTION_NAME = /^`([^`]+)`/;

/** The rule's sites, normalized like the old gate's. */
export function newFindings(root: string, gate: Gate, diagnostics: LintDiagnostic[]): string[] {
	const sites: string[] = [];
	const stale = new Set<string>();
	for (const diagnostic of diagnostics) {
		if (diagnostic.code !== `owlat(${gate.rule})`) continue;
		const path = relative(root, resolve(root, diagnostic.filename)).replaceAll('\\', '/');
		if (gate.perFunction) {
			const name = FUNCTION_NAME.exec(diagnostic.message)?.[1];
			if (name === undefined)
				throw new Error(`unreadable ${gate.rule} finding: ${diagnostic.message}`);
			if (diagnostic.message.includes('stale owlat/feature-floor-in-builder exemption')) {
				stale.add(`${path}:${name}`);
			} else sites.push(`${path}:${name}`);
		} else {
			sites.push(`${path}:${String(diagnostic.labels?.[0]?.span.line ?? 0)}`);
		}
	}
	if (gate.name === 'feature-floors') {
		// The old generator lists the justified sites too; the rule exempts them
		// through its `allow` list, and reports an entry nothing matches any more.
		for (const site of featureFloorAllowances()) {
			const path = site.slice(0, site.lastIndexOf(':'));
			if (existsSync(join(root, path)) && !stale.has(site)) sites.push(site);
		}
	}
	return sorted(sites);
}

export function compareGates(
	root: string,
	names: readonly GateName[] = GATES.map((gate) => gate.name)
): Comparison[] {
	const diagnostics = lintDiagnostics(root);
	return GATES.filter((gate) => names.includes(gate.name)).map((gate) => {
		const old = oldFindings(root, gate);
		const fresh = newFindings(root, gate, diagnostics);
		return {
			gate: gate.name,
			old,
			new: fresh,
			onlyOld: old.filter((site) => !fresh.includes(site)),
			onlyNew: fresh.filter((site) => !old.includes(site)),
		};
	});
}

/** The differences KNOWN_DIFFERENCES does not explain, and the entries nothing matches. */
export function unexplained(
	comparisons: readonly Comparison[],
	known: readonly KnownDifference[]
): { differences: string[]; stale: string[] } {
	const differences: string[] = [];
	const used = new Set<KnownDifference>();
	for (const comparison of comparisons) {
		for (const [side, sites] of [
			['old', comparison.onlyOld],
			['new', comparison.onlyNew],
		] as const) {
			for (const site of sites) {
				const entry = known.find(
					(candidate) =>
						candidate.gate === comparison.gate && candidate.side === side && candidate.site === site
				);
				if (entry) used.add(entry);
				else
					differences.push(
						`${comparison.gate}: only the ${side === 'old' ? 'text gate' : 'rule'} reports ${site}`
					);
			}
		}
	}
	const compared = new Set(comparisons.map((comparison) => comparison.gate));
	const stale = known
		.filter((entry) => compared.has(entry.gate) && !used.has(entry))
		.map((entry) => `${entry.gate}: ${entry.side} ${entry.site}`);
	return { differences, stale };
}

function main(argv: string[]): number {
	const rootIndex = argv.indexOf('--root');
	const root = rootIndex >= 0 ? resolve(argv[rootIndex + 1] ?? '.') : REPOSITORY_ROOT;
	const comparisons = compareGates(root);
	for (const { gate, old, new: fresh, onlyOld, onlyNew } of comparisons) {
		console.info(
			`${gate.padEnd(18)} text gate ${String(old.length).padStart(4)}  rule ${String(fresh.length).padStart(4)}  only-text ${onlyOld.length}  only-rule ${onlyNew.length}`
		);
	}
	const { differences, stale } = unexplained(
		comparisons,
		root === REPOSITORY_ROOT ? KNOWN_DIFFERENCES : []
	);
	if (differences.length > 0) {
		console.error(
			`\nFAIL: ${differences.length} unexplained difference(s) between a text gate and its rule:`
		);
		for (const difference of differences) console.error(`  ${difference}`);
		console.error(
			'\nFix whichever side is wrong. A difference that is right (a grep false positive, a spelling only the AST sees) goes into KNOWN_DIFFERENCES in scripts/ast-gate-parity.ts with its reason.'
		);
	}
	if (stale.length > 0) {
		console.error(
			`\nFAIL: ${stale.length} KNOWN_DIFFERENCES entr(y/ies) no longer differ; delete them:`
		);
		for (const entry of stale) console.error(`  ${entry}`);
	}
	if (differences.length > 0 || stale.length > 0) return 1;
	console.info('\nok:   every text gate and its oxlint rule agree, or differ for a listed reason');
	return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
