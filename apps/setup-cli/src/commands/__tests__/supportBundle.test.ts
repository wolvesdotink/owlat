import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSupportBundle, type SupportBundleIo } from '../supportBundle';
import type { CommandOptions, CommandResult } from '../../lib/boundedCommand';

/**
 * The whole command against a fake Docker: every section lands in one archive
 * the system `tar` extracts, a broken source becomes an `unavailable` section
 * instead of a failed run, and none of the personal data or secrets seeded into
 * logs, ledger errors and the rollout record survives into the archive.
 */

const SECRET = 'mta-master-key-0123456789';
const PII = [
	'marcel@example.com',
	'Marcel',
	'Invoice 4012',
	'secret-cursor',
	SECRET,
	'user_marcel',
];

const NOW = new Date('2026-10-24T10:15:00.000Z');
const STAMP = '20261024T101500Z';

const dirs: string[] = [];
function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

const fetchCalls: string[] = [];
beforeEach(() => {
	fetchCalls.length = 0;
	vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
		fetchCalls.push(`${init?.method ?? 'GET'} ${url}`);
		if (url.endsWith('/ip-audit')) return Response.json({ audits: [] });
		return Response.json({ status: 'ok' });
	});
});
afterEach(() => {
	vi.unstubAllGlobals();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function install(files: { rollout?: string } = {}): string {
	const dir = tempDir('owlat-install-');
	writeFileSync(
		join(dir, '.env'),
		[
			'OWLAT_VERSION=0.6.16',
			'EMAIL_PROVIDER=mta',
			'MTA_API_URL=http://mta:3100',
			`MTA_API_KEY=${SECRET}`,
		].join('\n')
	);
	writeFileSync(join(dir, '.owlat-flags.json'), JSON.stringify({ campaigns: true }));
	if (files.rollout !== undefined)
		writeFileSync(join(dir, '.owlat-last-rollout.json'), files.rollout);
	return dir;
}

const PS_ROWS = [
	{
		Service: 'web',
		State: 'running',
		Status: 'Up 2 hours (healthy)',
		Health: 'healthy',
		Image: 'ghcr.io/wolvesdotink/web:0.6.16',
	},
	{
		Service: 'mta',
		State: 'exited',
		Status: 'Exited (1) 3 minutes ago',
		Image: 'ghcr.io/wolvesdotink/mta:0.6.16',
	},
];

const LEDGER = {
	deployedVersion: '0.6.16',
	migrations: [
		{
			migration: '0067_empty_retired_summaries',
			introducedIn: '0.6.10',
			state: 'failed',
			stalledAt: null,
			hasError: true,
			error: 'Invoice 4012 of marcel@example.com',
			cursor: 'secret-cursor',
			startedAt: 1,
			updatedAt: 2,
			completedAt: null,
			pageCount: 3,
			scannedCount: 300,
			changedCount: 12,
		},
	],
	runner: {
		status: 'stopped',
		startedBy: 'user_marcel',
		startedAt: 1,
		updatedAt: 2,
		hasStoppedError: true,
	},
};

function logLines(service: string, count: number): string {
	return Array.from({ length: count }, (_, index) => {
		const stamp = `2026-10-24T10:00:${String(index).padStart(2, '0')}.000000000Z`;
		return index % 2 === 0
			? `${stamp} ${JSON.stringify({ level: 50, service: `owlat-${service}`, event: 'delivery.smtp.failed', msg: `to marcel@example.com: Invoice 4012 #${index}`, rcptTo: 'marcel@example.com', err: { type: 'SmtpError', message: SECRET, stack: 'at Marcel' } })}`
			: `${stamp} WARN plain text about Marcel <marcel@example.com>`;
	}).join('\n');
}

type Answer = Partial<CommandResult> | ((args: readonly string[]) => Partial<CommandResult>);

interface FakeIo extends SupportBundleIo {
	calls: Array<{ args: string[]; options: CommandOptions }>;
	stderr: string[];
	stdout: Uint8Array[];
}

function fakeIo(answers: Record<string, Answer> = {}, tty = false): FakeIo {
	const defaults: Record<string, Answer> = {
		'compose ps --format json': { output: JSON.stringify(PS_ROWS.slice(0, 1)) },
		'compose ps --all --format json': {
			output: PS_ROWS.map((row) => JSON.stringify(row)).join('\n'),
		},
		'compose --profile deploy run': { output: `notice\n${JSON.stringify(LEDGER, null, 2)}` },
		'version --format': { output: '27.3.1\n' },
		'compose version --short': { output: '2.29.7\n' },
		'compose logs': (args) => ({ output: logLines(args[args.length - 1]!, 10) }),
	};
	// An explicit answer wins over every default, then the longest prefix.
	const pick = (table: Record<string, Answer>, joined: string) =>
		Object.keys(table)
			.filter((prefix) => joined.startsWith(prefix))
			.sort((a, b) => b.length - a.length)[0];
	const io: FakeIo = {
		calls: [],
		stderr: [],
		stdout: [],
		async docker(args, options) {
			io.calls.push({ args: [...args], options });
			const joined = args.join(' ');
			const explicit = pick(answers, joined);
			const fallback = pick(defaults, joined);
			const answer = explicit ? answers[explicit]! : fallback ? defaults[fallback]! : { code: 1 };
			const result = typeof answer === 'function' ? answer(args) : answer;
			return { code: 0, output: '', truncated: false, timedOut: false, ...result };
		},
		now: () => NOW,
		log: (line) => io.stderr.push(line),
		writeStdout: async (data) => {
			io.stdout.push(data);
		},
		isStdoutTty: () => tty,
	};
	return io;
}

function extract(archive: string): Record<string, string> {
	const dir = tempDir('bundle-');
	execFileSync('tar', ['-xzf', archive, '-C', dir]);
	const files: Record<string, string> = {};
	const walk = (path: string) => {
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			const full = join(path, entry.name);
			if (entry.isDirectory()) walk(full);
			else files[relative(dir, full)] = readFileSync(full, 'utf8');
		}
	};
	walk(dir);
	return files;
}

const root = `owlat-support-${STAMP}`;
const json = (files: Record<string, string>, name: string) => JSON.parse(files[`${root}/${name}`]!);

describe('runSupportBundle', () => {
	it('writes every section, bounded logs, and nothing personal', async () => {
		const owlatDir = install({
			rollout: JSON.stringify({
				targetVersion: '0.6.16',
				startedAt: 100,
				phase: 'done',
				outcome: 'failed',
				summary: `pull failed for Marcel ${SECRET}`,
				finishedAt: 200,
			}),
		});
		const out = join(tempDir('out-'), 'bundle.tar.gz');
		const io = fakeIo();
		const code = await runSupportBundle(
			{ owlatDir, args: ['--lines', '3', '--output', out], cliVersion: '0.6.16' },
			io
		);
		expect(code).toBe(0);
		expect(statSync(out).mode & 0o777).toBe(0o600);
		expect(readdirSync(join(out, '..'))).toEqual(['bundle.tar.gz']);

		const files = extract(out);
		expect(Object.keys(files).sort()).toEqual(
			[
				'compose-ps.json',
				'doctor.json',
				'logs/mta.ndjson',
				'logs/web.ndjson',
				'manifest.json',
				'migrations.json',
				'rollout.json',
				'versions.json',
			].map((name) => `${root}/${name}`)
		);

		const manifest = json(files, 'manifest.json');
		expect(manifest).toMatchObject({
			schemaVersion: 1,
			command: 'support-bundle',
			generatedAt: NOW.toISOString(),
			cliVersion: '0.6.16',
			options: { lines: 3 },
			sections: {
				doctor: { status: 'ok' },
				compose: { status: 'ok' },
				migrations: { status: 'ok' },
				rollout: { status: 'ok' },
				versions: { status: 'ok' },
				logs: { status: 'ok' },
			},
		});
		expect(manifest.logs).toEqual([
			{ service: 'mta', file: 'logs/mta.ndjson', lines: 3, truncated: false, status: 'ok' },
			{ service: 'web', file: 'logs/web.ndjson', lines: 3, truncated: false, status: 'ok' },
		]);

		const webLog = files[`${root}/logs/web.ndjson`]!.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		expect(webLog).toHaveLength(3);
		expect(webLog[0]).toMatchObject({
			t: '2026-10-24T10:00:07.000000000Z',
			format: 'text',
			level: 'warn',
		});
		expect(webLog[1]).toMatchObject({
			format: 'json',
			level: 'error',
			event: 'delivery.smtp.failed',
			service: 'owlat-web',
			errType: 'SmtpError',
		});

		expect(
			json(files, 'compose-ps.json').services.map((row: { service: string }) => row.service)
		).toEqual(['mta', 'web']);
		expect(json(files, 'versions.json')).toEqual({
			status: 'ok',
			cli: '0.6.16',
			configured: '0.6.16',
			deployedFunctions: '0.6.16',
			dockerEngine: '27.3.1',
			dockerCompose: '2.29.7',
			running: { mta: '0.6.16', web: '0.6.16' },
		});
		expect(json(files, 'migrations.json').migrations[0]).toMatchObject({
			state: 'failed',
			hasError: true,
		});
		expect(json(files, 'rollout.json').rollout).toMatchObject({
			outcome: 'failed',
			hasSummary: true,
		});
		const doctor = json(files, 'doctor.json');
		expect(doctor.report.command).toBe('doctor');
		expect(
			doctor.report.checks.some((check: { id: string }) => check.id === 'containers.health')
		).toBe(true);

		for (const [name, content] of Object.entries(files)) {
			for (const needle of PII) expect(content, `${needle} in ${name}`).not.toContain(needle);
		}

		// The logs are asked for N lines with a byte cap, and kept from the end.
		const logCall = io.calls.find((call) => call.args[1] === 'logs')!;
		expect(logCall.args).toEqual([
			'compose',
			'logs',
			'--no-color',
			'--no-log-prefix',
			'--timestamps',
			'--tail',
			'3',
			'mta',
		]);
		expect(logCall.options).toMatchObject({
			keep: 'tail',
			mergeStderr: true,
			maxBytes: 3 * 16 * 1024,
		});
		// Read-only: the ledger read starts nothing else, and doctor does not recheck the MTA identity.
		expect(io.calls.find((call) => call.args.includes('convex-deploy'))!.args).toContain(
			'--no-deps'
		);
		expect(fetchCalls.some((call) => call.includes('/identity/recheck'))).toBe(false);
		expect(fetchCalls.some((call) => call.startsWith('GET http://mta:3100/health'))).toBe(true);
	});

	it('still writes a bundle when Docker is unavailable, with each section saying why', async () => {
		const owlatDir = install();
		const out = join(tempDir('out-'), 'bundle.tar.gz');
		const io = fakeIo({
			compose: { code: 127 },
			version: { code: 127 },
		});
		expect(
			await runSupportBundle({ owlatDir, args: ['--output', out], cliVersion: '0.6.16' }, io)
		).toBe(0);
		const files = extract(out);
		const manifest = json(files, 'manifest.json');
		expect(manifest.sections).toEqual({
			doctor: { status: 'ok' },
			compose: { status: 'unavailable', reason: 'docker_unavailable' },
			migrations: { status: 'unavailable', reason: 'docker_unavailable' },
			rollout: { status: 'absent' },
			versions: { status: 'ok' },
			logs: { status: 'unavailable', reason: 'docker_unavailable' },
		});
		expect(manifest.logs).toEqual([]);
		expect(json(files, 'versions.json')).toMatchObject({
			dockerEngine: null,
			running: null,
			configured: '0.6.16',
		});
		const checks = json(files, 'doctor.json').report.checks.map(
			(check: { id: string }) => check.id
		);
		expect(checks).toContain('compose.cli');
	});

	it('tells a failed, timed-out, oversized or unparseable source apart', async () => {
		const owlatDir = install({ rollout: '{ not json' });
		const out = join(tempDir('out-'), 'bundle.tar.gz');
		const io = fakeIo({
			'compose ps --all --format json': { truncated: true },
			'compose --profile deploy run': {
				output: 'Error: Could not find function for marcel@example.com',
			},
		});
		await runSupportBundle({ owlatDir, args: ['--output', out], cliVersion: '0.6.16' }, io);
		const files = extract(out);
		expect(json(files, 'manifest.json').sections).toMatchObject({
			compose: { status: 'unavailable', reason: 'output_too_large' },
			migrations: { status: 'unavailable', reason: 'unparseable' },
			rollout: { status: 'unavailable', reason: 'invalid_record' },
		});
		expect(JSON.stringify(files)).not.toContain('marcel@example.com');

		const timedOut = fakeIo({ 'compose --profile deploy run': { code: 137, timedOut: true } });
		const out2 = join(tempDir('out-'), 'bundle.tar.gz');
		await runSupportBundle({ owlatDir, args: ['--output', out2], cliVersion: '0.6.16' }, timedOut);
		expect(json(extract(out2), 'manifest.json').sections.migrations).toEqual({
			status: 'unavailable',
			reason: 'timed_out',
		});
	});

	it('records one service whose logs cannot be read and keeps the others', async () => {
		const owlatDir = install();
		const out = join(tempDir('out-'), 'bundle.tar.gz');
		const io = fakeIo({
			'compose logs': (args) =>
				args[args.length - 1] === 'mta' ? { code: 1 } : { output: logLines('web', 2) },
		});
		await runSupportBundle({ owlatDir, args: ['--output', out], cliVersion: '0.6.16' }, io);
		const files = extract(out);
		expect(json(files, 'manifest.json').logs).toEqual([
			{
				service: 'mta',
				file: 'logs/mta.ndjson',
				lines: 0,
				truncated: false,
				status: 'unavailable',
				reason: 'command_failed',
			},
			{ service: 'web', file: 'logs/web.ndjson', lines: 2, truncated: false, status: 'ok' },
		]);
		expect(files[`${root}/logs/mta.ndjson`]).toBeUndefined();
	});

	it('writes the archive to stdout for the wrapper, and never to a terminal', async () => {
		const owlatDir = install();
		const io = fakeIo();
		expect(
			await runSupportBundle({ owlatDir, args: ['--output', '-'], cliVersion: '0.6.16' }, io)
		).toBe(0);
		expect(io.stdout).toHaveLength(1);
		const file = join(tempDir('out-'), 'from-stdout.tar.gz');
		writeFileSync(file, io.stdout[0]!);
		expect(Object.keys(extract(file))).toContain(`${root}/manifest.json`);

		const tty = fakeIo({}, true);
		expect(
			await runSupportBundle({ owlatDir, args: ['--output', '-'], cliVersion: '0.6.16' }, tty)
		).toBe(1);
		expect(tty.stdout).toHaveLength(0);
		expect(tty.calls).toHaveLength(0);
	});

	it('refuses invalid options and an existing output before collecting anything', async () => {
		const owlatDir = install();
		const outDir = tempDir('out-');
		const existing = join(outDir, 'existing.tar.gz');
		writeFileSync(existing, 'keep me');
		const cases: Array<[string[], RegExp]> = [
			[['--lines', '0'], /between 1 and 5000/],
			[['--lines', '5001'], /between 1 and 5000/],
			[['--lines', 'all'], /whole number/],
			[['--lines', '-5'], /whole number/],
			[['--output='], /needs a file path/],
			[['--lines'], /--lines needs a value/],
			[['--output'], /--output needs a value/],
			[['--lines', '5', '--output'], /--output needs a value/],
			[['extra'], /Unexpected argument/],
			[['--output', existing], /already exists/],
		];
		for (const [args, message] of cases) {
			const io = fakeIo();
			expect(await runSupportBundle({ owlatDir, args, cliVersion: '0.6.16' }, io)).toBe(1);
			expect(io.stderr.join('\n')).toMatch(message);
			expect(io.calls).toHaveLength(0);
		}
		expect(readFileSync(existing, 'utf8')).toBe('keep me');
		expect(readdirSync(outDir)).toEqual(['existing.tar.gz']);
	});

	it('leaves no partial file behind when the archive cannot be written', async () => {
		const owlatDir = install();
		const outDir = tempDir('out-');
		const target = join(outDir, 'missing-dir', 'bundle.tar.gz');
		await expect(
			runSupportBundle({ owlatDir, args: ['--output', target], cliVersion: '0.6.16' }, fakeIo())
		).rejects.toThrow();
		expect(readdirSync(outDir)).toEqual([]);
	});

	it('never replaces an output that appears while the bundle is collected', async () => {
		const owlatDir = install();
		const outDir = tempDir('out-');
		const target = join(outDir, 'bundle.tar.gz');
		const io = fakeIo({
			'compose logs': (args) => {
				writeFileSync(target, 'created meanwhile');
				return { output: logLines(args[args.length - 1]!, 2) };
			},
		});
		expect(
			await runSupportBundle({ owlatDir, args: ['--output', target], cliVersion: '0.6.16' }, io)
		).toBe(1);
		expect(io.stderr.join('\n')).toMatch(/was created while the bundle was collected/);
		expect(readFileSync(target, 'utf8')).toBe('created meanwhile');
		expect(readdirSync(outDir)).toEqual(['bundle.tar.gz']);
	});

	it('keeps only code-owned doctor text, whatever the MTA answers', async () => {
		vi.stubGlobal('fetch', async (url: string) => {
			if (url.endsWith('/ip-audit')) {
				return Response.json({
					audits: [
						{
							ip: '192.0.2.10',
							verdict: 'unusable',
							headline: 'Invoice 4012 belongs to Alice Smith',
							nextAction: 'Call Alice Smith on +1 555 0100.',
							delisting: [{ label: 'Alice list', removalUrl: 'https://example.com/alice' }],
						},
					],
				});
			}
			return Response.json({ status: 'ok' });
		});
		const owlatDir = install();
		const out = join(tempDir('out-'), 'bundle.tar.gz');
		expect(
			await runSupportBundle({ owlatDir, args: ['--output', out], cliVersion: '0.6.16' }, fakeIo())
		).toBe(0);
		const files = extract(out);
		const audit = json(files, 'doctor.json').report.checks.find(
			(check: { id: string }) => check.id === 'mta.ip_audit'
		);
		expect(audit).toMatchObject({
			subject: '192.0.2.10',
			status: 'fail',
			remediation: 'replace_or_delist_ip',
			message: 'IP audit for [redacted]: [redacted]',
		});
		for (const needle of ['Alice', 'Invoice 4012', '555 0100', 'example.com/alice']) {
			expect(JSON.stringify(files)).not.toContain(needle);
		}
	});

	it('archives the logs of a service with the longest name compose allows', async () => {
		const service = `s${'x'.repeat(63)}`;
		const owlatDir = install();
		const out = join(tempDir('out-'), 'bundle.tar.gz');
		const io = fakeIo({
			'compose ps --all --format json': {
				output: JSON.stringify({ ...PS_ROWS[0], Service: service }),
			},
		});
		expect(
			await runSupportBundle({ owlatDir, args: ['--output', out], cliVersion: '0.6.16' }, io)
		).toBe(0);
		const files = extract(out);
		expect(files[`${root}/logs/${service}.ndjson`]).toBeDefined();
		expect(json(files, 'manifest.json').logs).toMatchObject([{ service, status: 'ok' }]);
	});
});
