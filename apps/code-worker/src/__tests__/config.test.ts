import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	configuredOpencodeBin,
	loadWorkerTimers,
	readRepositorySettings,
	readSandboxIds,
	sandboxParentEnv,
	trustedGitEnv,
	workspaceRoot,
} from '../config.js';
import { buildAgentEnv, buildTestEnv, loadTaskRunnerConfig } from '../taskRunner.js';
import { buildJobEnv } from '../pluginTaskRunner.js';

/**
 * config.ts is the worker's one reader of the environment; the rest of the
 * worker gets values from it. These cases pin the defaults it owns and, above
 * all, what an untrusted child can be built from.
 */

const SECRETS = {
	GITHUB_TOKEN: 'ghp_secret',
	CONVEX_ADMIN_KEY: 'admin-secret',
	CODE_WORKER_CONVEX_KEY: 'scoped-secret',
	GIT_REPO_URL: 'https://x-access-token:ghp_secret@github.com/o/r.git',
};

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
	savedEnv = process.env;
	process.env = {
		PATH: '/usr/bin',
		LLM_BASE_URL: 'https://llm.example.com',
		LLM_API_KEY: 'llm-secret',
		...SECRETS,
	};
});

afterEach(() => {
	process.env = savedEnv;
});

describe('settings and their defaults', () => {
	it('defaults the workspace root, opencode binary and repository branch', () => {
		expect(workspaceRoot()).toBe('/workspace');
		expect(configuredOpencodeBin()).toBeUndefined();
		expect(readRepositorySettings()).toEqual({
			gitRepoUrl: SECRETS.GIT_REPO_URL,
			workspaceRoot: '/workspace',
			baseBranch: 'main',
			githubOwner: '',
			githubRepo: '',
		});
	});

	it('reads overrides when asked, not when the module loaded', () => {
		process.env['WORKSPACE_ROOT'] = '/data/tasks';
		process.env['OPENCODE_BIN'] = '/opt/opencode/bin/opencode';
		process.env['GIT_BASE_BRANCH'] = 'develop';
		expect(workspaceRoot()).toBe('/data/tasks');
		expect(configuredOpencodeBin()).toBe('/opt/opencode/bin/opencode');
		expect(readRepositorySettings()).toMatchObject({
			workspaceRoot: '/data/tasks',
			baseBranch: 'develop',
		});
	});

	it('builds the task config without the credential in the clone URL', () => {
		const config = loadTaskRunnerConfig();
		expect(config.repoUrl).toBe('https://github.com/o/r.git');
		expect(config.repoUrl).not.toContain('ghp_secret');
		expect(config.gitAuthEnv['GIT_CONFIG_KEY_0']).toBe('http.extraheader');
	});

	it('defaults the sandbox ids to the Dockerfile account and refuses a bad override', () => {
		expect(readSandboxIds()).toEqual({ uid: 10001, gid: 10001 });
		process.env['CODE_SANDBOX_UID'] = '0';
		expect(() => readSandboxIds()).toThrow(/CODE_SANDBOX_UID must be an integer of at least 1/);
		process.env['CODE_SANDBOX_UID'] = '20001';
		process.env['CODE_SANDBOX_GID'] = '20001x';
		expect(() => readSandboxIds()).toThrow(/CODE_SANDBOX_GID must be an integer/);
	});

	it('refuses a malformed timer', () => {
		expect(loadWorkerTimers().pollIntervalMs).toBe(10_000);
		process.env['POLL_INTERVAL_MS'] = '10s';
		expect(() => loadWorkerTimers()).toThrow(/^POLL_INTERVAL_MS /);
	});
});

describe('child environments', () => {
	it('offers an untrusted child nothing but PATH and the LLM endpoint', () => {
		expect(sandboxParentEnv()).toEqual({
			PATH: '/usr/bin',
			LLM_BASE_URL: 'https://llm.example.com',
			LLM_API_KEY: 'llm-secret',
		});
	});

	it('builds every sandboxed child from that set by default', () => {
		const children = [
			buildAgentEnv('/workspace/t.home'),
			buildTestEnv('/workspace/t.home'),
			buildJobEnv('/workspace/plugin-t'),
		];
		for (const env of children) {
			for (const [name, value] of Object.entries(SECRETS)) {
				expect(env[name], name).toBeUndefined();
				expect(Object.values(env), name).not.toContain(value);
			}
			expect(env['PATH']).toBe('/usr/bin');
		}
		expect(children[0]!['LLM_API_KEY']).toBe('llm-secret');
		expect(children[1]!['LLM_API_KEY']).toBeUndefined();
		expect(children[2]!['LLM_API_KEY']).toBeUndefined();
	});

	it('gives the root-run git commands the worker environment plus the credential header', () => {
		const env = trustedGitEnv({ GIT_CONFIG_COUNT: '1' });
		expect(env).toEqual({ ...process.env, GIT_CONFIG_COUNT: '1' });
		env['PATH'] = '/changed';
		expect(process.env['PATH']).toBe('/usr/bin');
	});
});
