/**
 * Release-compose interpolation guard.
 *
 * `_server-build.yml` proves the published `docker-compose-<version>.yml` is
 * parseable by running `docker compose config` against it with a placeholder
 * env. Compose treats `${VAR:?message}` as REQUIRED: one such variable missing
 * from that placeholder list fails the step, which fails the
 * `upload-release-assets` job, which skips `publish` — the release is built,
 * signed, and then never goes live. v0.4.0 died exactly that way (three vars
 * added to compose, none added to the workflow), and `REDIS_PASSWORD` set up
 * the same trap for v0.4.5.
 *
 * So the two lists are pinned against each other here, off the real files: no
 * docker needed, and a new required compose var fails on the PR that adds it
 * instead of on the release that ships it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const COMPOSE = 'docker-compose.yml';
const WORKFLOW = '.github/workflows/_server-build.yml';
const VERIFY_STEP = 'Verify compose file is parseable';
/** The e2e-install job writes a real `.env` with this heredoc before `up`. */
const E2E_ENV_HEREDOC = 'cat > .env <<EOF';

function read(relativePath: string): string {
	return readFileSync(join(REPOSITORY_ROOT, relativePath), 'utf8');
}

/** Every `${VAR:?…}` in the compose file — the ones compose refuses to default. */
function requiredComposeVars(compose: string): string[] {
	const names = new Set<string>();
	for (const match of compose.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*):\?/g)) {
		names.add(match[1]!);
	}
	return [...names].sort();
}

/** The `env:` keys of the verify step, read off the workflow as written. */
function verifyStepEnvKeys(workflow: string): string[] {
	const lines = workflow.split('\n');
	const stepIndex = lines.findIndex((line) => line.includes(`- name: ${VERIFY_STEP}`));
	expect(stepIndex, `step "${VERIFY_STEP}" not found in ${WORKFLOW}`).toBeGreaterThan(-1);

	const envIndex = lines.findIndex((line, i) => i > stepIndex && /^\s+env:\s*$/.test(line));
	expect(envIndex, `step "${VERIFY_STEP}" has no env block`).toBeGreaterThan(stepIndex);

	const indent = (lines[envIndex]!.match(/^\s*/)?.[0].length ?? 0) + 2;
	const keys: string[] = [];
	for (const line of lines.slice(envIndex + 1)) {
		if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
		const depth = line.match(/^\s*/)?.[0].length ?? 0;
		if (depth < indent) break;
		const key = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*):/)?.[1];
		if (key) keys.push(key);
	}
	return keys.sort();
}

/**
 * The `KEY=` names of the e2e-install job's `.env` heredoc, read as written.
 * Stops at the heredoc terminator so the shell around it cannot leak in.
 */
function e2eEnvKeys(workflow: string): string[] {
	const lines = workflow.split('\n');
	const start = lines.findIndex((line) => line.includes(E2E_ENV_HEREDOC));
	expect(start, `heredoc "${E2E_ENV_HEREDOC}" not found in ${WORKFLOW}`).toBeGreaterThan(-1);

	const keys: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (line.trim() === 'EOF') break;
		const key = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=/)?.[1];
		if (key) keys.push(key);
	}
	return keys.sort();
}

describe('release compose placeholder env', () => {
	it('supplies a placeholder for every required compose variable', () => {
		const required = requiredComposeVars(read(COMPOSE));
		const supplied = new Set(verifyStepEnvKeys(read(WORKFLOW)));

		expect(required.length).toBeGreaterThan(0);
		expect(
			required.filter((name) => !supplied.has(name)),
			`add these to the "${VERIFY_STEP}" env in ${WORKFLOW}, or the release will build but never publish`
		).toEqual([]);
	});
});

/**
 * The verify step above only proves the compose file PARSES. The e2e-install job
 * then brings the stack UP for real against a `.env` it writes itself — a second,
 * independent list that nothing used to check. A `${VAR:?}` missing from it
 * parses fine in the verify step and then fails the actual `docker compose up`,
 * so it is pinned against the same source of truth here.
 */
describe('e2e-install .env', () => {
	it('sets every required compose variable before bringing the stack up', () => {
		const required = requiredComposeVars(read(COMPOSE));
		const supplied = new Set(e2eEnvKeys(read(WORKFLOW)));

		expect(required.length).toBeGreaterThan(0);
		expect(
			required.filter((name) => !supplied.has(name)),
			`add these to the "${E2E_ENV_HEREDOC}" block in ${WORKFLOW}, or e2e-install fails at \`docker compose up\``
		).toEqual([]);
	});
});
