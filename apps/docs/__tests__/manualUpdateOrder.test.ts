import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from './repoVocabulary';

/**
 * Every hand-run update recipe deploys the Convex functions before it recreates
 * the containers, the order `apps/updater/src/update.ts` follows. The other way
 * round, the new web, MTA and IMAP containers run against the previous
 * release's functions until the deploy finishes, which the compatibility rules
 * in `apps/api/convex/CONVENTIONS.md` do not cover.
 *
 * The order alone is not enough: operators paste the block into a shell, so a
 * failed step has to stop it, above all a failed deploy before `up -d`. The
 * recipes are run in bash with `docker`, `curl` and `sha256sum` stubbed and one
 * step failing at a time. The manual rollback recreates first on purpose (see
 * the maintenance page), so it is only part of the failure-path checks.
 */

const read = (path: string) => readFileSync(resolve(REPO_ROOT, path), 'utf8');

const DEPLOY = 'docker compose --profile deploy run --rm convex-deploy';
const RECREATE = /docker compose up -d\s*$/m;

/** From the line matching `start` up to the first later line matching `end`. */
function section(text: string, start: RegExp, end: RegExp): string {
	const from = text.search(start);
	expect(from, `no section starting with ${start}`).toBeGreaterThanOrEqual(0);
	const bodyAt = text.indexOf('\n', from) + 1;
	const stop = text.slice(bodyAt).search(end);
	return stop < 0 ? text.slice(from) : text.slice(from, bodyAt + stop);
}

/** The body of the first ```bash or ```sh fence in `text`, dedented. */
function fence(text: string): string {
	const match = /^([ \t]*)```(?:bash|sh)\n([\s\S]*?)(?:\n[ \t]*```|(?![\s\S]))/m.exec(text);
	expect(match, 'no shell code block').not.toBeNull();
	const [, indent, body] = match!;
	return body
		.split('\n')
		.map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line))
		.join('\n');
}

const maintenancePage = (locale: string) =>
	read(`apps/docs/content/${locale}/3.developer/34.self-hosting-maintenance.md`);

interface Recipe {
	name: string;
	/** The recipe with the prose around it. */
	text: () => string;
	/** The commands as an operator pastes them. */
	script: () => string;
}

const releaseNotes = () =>
	section(read('.github/workflows/release.yml'), /Manual upgrade/, /```\s*$/m);
const composeHeader = () =>
	section(read('scripts/gen-release-compose.sh'), /apply it manually/, /^EOF$/m);

const UPDATES: Recipe[] = [
	...['en', 'de'].map((locale) => {
		const text = () => section(maintenancePage(locale), /^### Option C\b/m, /^##/m);
		return { name: `${locale} maintenance page, Option C`, text, script: () => fence(text()) };
	}),
	{
		name: 'release notes',
		text: releaseNotes,
		// The workflow fills in `${{ … }}` before it publishes the notes.
		script: () => fence(releaseNotes()).replace(/\$\{\{[^}]*\}\}/g, '1.2.3'),
	},
	{
		name: 'release compose header',
		text: composeHeader,
		// The commands are the comment lines indented by three spaces; the heredoc
		// turns `\\` into `\`.
		script: () =>
			composeHeader()
				.split('\n')
				.filter((line) => line.startsWith('#   '))
				.map((line) => line.slice(4).replaceAll('\\\\', '\\'))
				.join('\n'),
	},
];

const ROLLBACKS: Recipe[] = [
	['en', 'Manually'],
	['de', 'Manuell'],
].map(([locale, label]) => {
	const text = () =>
		section(maintenancePage(locale), new RegExp(`^\\*\\*${label}:\\*\\*`, 'm'), /^##/m);
	return { name: `${locale} maintenance page, manual rollback`, text, script: () => fence(text()) };
});

// Each stub logs its command line; the call whose number is STUB_FAIL_AT
// exits 42 instead of 0.
const sandbox = mkdtempSync(join(tmpdir(), 'manual-update-order-'));
const bin = join(sandbox, 'bin');
mkdirSync(bin);
for (const command of ['docker', 'curl', 'sha256sum']) {
	const stub = join(bin, command);
	writeFileSync(
		stub,
		[
			'#!/bin/sh',
			`echo "${command} $*" >> "$STUB_LOG"`,
			'[ "$(wc -l < "$STUB_LOG")" -eq "${STUB_FAIL_AT:-0}" ] && exit 42',
			'exit 0',
			'',
		].join('\n')
	);
	chmodSync(stub, 0o755);
}
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

let runs = 0;
/** Runs `script` in bash, failing the `failAt`-th stubbed call (0: none). */
function run(script: string, failAt = 0): { status: number | null; calls: string[] } {
	const log = join(sandbox, `calls-${++runs}.log`);
	writeFileSync(log, '');
	const result = spawnSync('bash', ['-c', script], {
		cwd: sandbox,
		encoding: 'utf8',
		timeout: 10_000,
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH}`,
			STUB_LOG: log,
			STUB_FAIL_AT: String(failAt),
		},
	});
	const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
	return { status: result.status, calls };
}

describe('manual update recipes', () => {
	it.each(UPDATES)('$name deploys the functions before recreating containers', ({ text }) => {
		const recipe = text();
		const deployAt = recipe.indexOf(DEPLOY);
		const recreateAt = recipe.search(RECREATE);
		expect(deployAt, 'no convex-deploy step').toBeGreaterThanOrEqual(0);
		expect(recreateAt, 'no `docker compose up -d` step').toBeGreaterThanOrEqual(0);
		expect(deployAt).toBeLessThan(recreateAt);
	});

	it.each(UPDATES)('$name never runs `up -d` after a failed deploy', ({ script }) => {
		const { calls: all } = run(script());
		const deployCall = all.indexOf(DEPLOY) + 1;
		expect(deployCall, 'no convex-deploy call').toBeGreaterThan(0);

		const { status, calls } = run(script(), deployCall);
		expect(calls.at(-1)).toBe(DEPLOY);
		expect(calls).not.toContain('docker compose up -d');
		expect(status).not.toBe(0);
	});

	it.each([...UPDATES, ...ROLLBACKS])('$name stops at the first failing step', ({ script }) => {
		const { status, calls: all } = run(script());
		expect(status).toBe(0);
		expect(all).toContain(DEPLOY);
		expect(all).toContain('docker compose up -d');

		for (let step = 1; step <= all.length; step++) {
			const failed = run(script(), step);
			expect(failed.calls, `step ${step} (${all[step - 1]}) failed`).toEqual(all.slice(0, step));
			expect(failed.status, `step ${step} (${all[step - 1]}) failed`).toBe(42);
		}
	});
});
