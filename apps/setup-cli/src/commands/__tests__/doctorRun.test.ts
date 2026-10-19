import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor, type DoctorIo } from '../doctorRun';
import {
	DOCTOR_CHECK_IDS,
	DOCTOR_REPORT_SCHEMA_VERSION,
	type DoctorReport,
} from '../../lib/doctorReport';

/**
 * `doctor --json` must be the checklist in another form: every check the text
 * mode prints appears in the JSON, in the same order, with the same pass/fail,
 * and neither output carries a secret. Each fixture runs the WHOLE command
 * twice (text, then JSON) against the same install and compares the two.
 */

// CI forces colour (FORCE_COLOR), so compare the text with ANSI codes removed.
// eslint-disable-next-line no-control-regex
const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '');

const MTA_KEY = 'mta-master-key-0123456789';
const URL_PASSWORD = 'url-password-9876';
const RESEND_KEY = 're_live_secret_abcdef';

interface Fixture {
	env: string;
	flags?: string;
	override?: boolean;
	/** stdout of `docker compose ps`, or an error when docker cannot run. */
	compose: string | Error;
	fetch?: (url: string, init?: RequestInit) => Response;
}

const healthyMta = {
	status: 'ok',
	redis: 'connected',
	worker: { alive: true },
	dns: 'ok',
	emergency: { allIpsBlocked: false },
	ips: [
		{
			ip: '192.0.2.10',
			fcrdns: { verdict: 'pass', ehlo: 'mail.example.com', ptrNames: ['mail.example.com'] },
		},
	],
	smtpOutbound: { status: 'ok', ips: [{ ip: '192.0.2.10', status: 'ok' }] },
};

const brokenMta = {
	status: 'degraded',
	redis: 'disconnected',
	worker: { alive: false },
	dns: 'error',
	emergency: { allIpsBlocked: true },
	ips: [
		{
			ip: '192.0.2.10',
			fcrdns: { verdict: 'fail', reason: 'ehlo-mismatch', ehlo: 'mail.example.com', ptrNames: [] },
		},
	],
	queue: { status: 'orphaned', orphaned: 3, sampled: 10, overdue: 40 },
	smtpOutbound: {
		status: 'blocked',
		ips: [{ ip: '192.0.2.10', status: 'blocked', reason: 'connect_timeout' }, 'not-a-row'],
	},
};

const unusableAudit = {
	audits: [
		{
			ip: '192.0.2.10',
			verdict: 'unusable',
			headline: 'This address is listed.',
			nextAction: 'Ask the provider for a new address.',
		},
	],
};

const composeRows = (rows: Array<Record<string, string>>) =>
	rows.map((row) => JSON.stringify(row)).join('\n');

const FIXTURES: Record<string, Fixture> = {
	healthy: {
		env: [
			'EMAIL_PROVIDER=mta',
			'MTA_API_URL=http://mta:3100',
			`MTA_API_KEY=${MTA_KEY}`,
			'OWLAT_VERSION=0.6.15',
		].join('\n'),
		flags: JSON.stringify({ campaigns: true }),
		override: true,
		compose: composeRows([
			{
				Service: 'web',
				State: 'running',
				Status: 'Up 2 hours',
				Image: 'ghcr.io/wolvesdotink/web:0.6.15',
			},
		]),
		fetch: (url) => Response.json(url.endsWith('/ip-audit') ? { audits: [] } : healthyMta),
	},
	brokenMta: {
		env: [
			'EMAIL_PROVIDER=mta',
			// A password in the URL is a credential even though the key is not secret-shaped.
			`MTA_API_URL=http://admin:${URL_PASSWORD}@mta:3100`,
			`MTA_API_KEY=${MTA_KEY}`,
			'OWLAT_VERSION=0.6.15',
		].join('\n'),
		flags: JSON.stringify({ campaigns: true, ai: true }),
		compose: composeRows([
			{
				Service: 'web',
				State: 'running',
				Status: 'Up 2 hours (unhealthy)',
				Health: 'unhealthy',
				Image: 'ghcr.io/wolvesdotink/web:0.6.14',
			},
		]),
		fetch: (url) => Response.json(url.endsWith('/ip-audit') ? unusableAudit : brokenMta),
	},
	unreachable: {
		env: [
			'EMAIL_PROVIDER=mta',
			`MTA_API_URL=http://admin:${URL_PASSWORD}@mta:3100`,
			`MTA_API_KEY=${MTA_KEY}`,
		].join('\n'),
		flags: '{ not json',
		compose: new Error('spawn docker ENOENT'),
		fetch: () => {
			throw new Error('connect ECONNREFUSED');
		},
	},
	invalidHealth: {
		env: ['EMAIL_PROVIDER=mta', 'MTA_API_URL=http://mta:3100'].join('\n'),
		flags: JSON.stringify({ campaigns: true }),
		compose: '',
		fetch: () => Response.json({ status: 'ok' }),
	},
	providerMixup: {
		// The operator pasted the API key into the provider variable.
		env: [`EMAIL_PROVIDER=${RESEND_KEY}`, `RESEND_API_KEY=${RESEND_KEY}`].join('\n'),
		flags: JSON.stringify({ campaigns: true }),
		compose: '',
	},
	missingCredential: {
		env: 'EMAIL_PROVIDER=resend',
		flags: JSON.stringify({ campaigns: true }),
		compose: '',
	},
	noIdentityRows: {
		env: ['EMAIL_PROVIDER=mta', 'MTA_API_URL=http://mta:3100'].join('\n'),
		flags: JSON.stringify({ campaigns: true }),
		compose: '',
		fetch: () => Response.json({ ...healthyMta, ips: [], smtpOutbound: { ips: [] } }),
	},
};

const SECRETS = [MTA_KEY, URL_PASSWORD, RESEND_KEY];
const TEXT_PREFIXES = ['', 'SEND PATH: ', 'CONTAINERS: ', 'VERSION: '];
const NOW = new Date('2026-10-19T08:00:00.000Z');

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'owlat-doctor-'));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	vi.unstubAllGlobals();
});

function install(fixture: Fixture): void {
	writeFileSync(join(dir, '.env'), `${fixture.env}\n`);
	if (fixture.flags !== undefined) writeFileSync(join(dir, '.owlat-flags.json'), fixture.flags);
	if (fixture.override) writeFileSync(join(dir, 'docker-compose.override.yml'), 'services: {}\n');
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: string | URL, init?: RequestInit) => {
			if (!fixture.fetch) throw new Error('unexpected fetch');
			return fixture.fetch(String(input), init);
		})
	);
}

async function run(fixture: Fixture, json: boolean): Promise<{ code: number; stdout: string }> {
	const lines: string[] = [];
	const io: DoctorIo = {
		composePs: async () => {
			if (fixture.compose instanceof Error) throw fixture.compose;
			return fixture.compose;
		},
		now: () => NOW,
		print: (line) => lines.push(line),
	};
	const code = await runDoctor({ owlatDir: dir, positional: [], args: json ? ['--json'] : [] }, io);
	return { code, stdout: lines.join('\n') };
}

async function runBoth(fixture: Fixture) {
	install(fixture);
	const text = await run(fixture, false);
	const json = await run(fixture, true);
	return { text, json, report: JSON.parse(json.stdout) as DoctorReport };
}

/** The ✓/✗ checklist rows of the text output, as [passed, line-without-mark]. */
function checklist(stdout: string): Array<[boolean, string]> {
	return stripAnsi(stdout)
		.split('\n')
		.filter((line) => line.startsWith('✓ ') || line.startsWith('✗ '))
		.map((line) => [line.startsWith('✓'), line.slice(2)]);
}

describe('doctor --json — text/JSON parity', () => {
	const seen = new Set<string>();

	it.each(Object.keys(FIXTURES))('reports the same checks in both modes: %s', async (name) => {
		const { text, json, report } = await runBoth(FIXTURES[name]!);

		const rows = checklist(text.stdout);
		expect(report.checks).toHaveLength(rows.length);
		for (const [index, check] of report.checks.entries()) {
			const [passed, line] = rows[index]!;
			expect(check.status === 'pass').toBe(passed);
			// The text line is the JSON message behind the component's old prefix.
			expect(line.endsWith(check.message)).toBe(true);
			expect(TEXT_PREFIXES).toContain(line.slice(0, line.length - check.message.length));
			expect(check.remediation === undefined).toBe(passed);
			seen.add(check.id);
		}

		// Same verdict and exit code either way.
		expect(json.code).toBe(text.code);
		expect(report.ok).toBe(text.code === 0);
		expect(report.summary).toEqual({
			total: rows.length,
			passed: rows.filter(([passed]) => passed).length,
			failed: rows.filter(([passed]) => !passed).length,
		});
		expect(report.schemaVersion).toBe(DOCTOR_REPORT_SCHEMA_VERSION);
		expect(report.generatedAt).toBe(NOW.toISOString());

		// No secret value in either output.
		for (const secret of SECRETS) {
			expect(text.stdout).not.toContain(secret);
			expect(json.stdout).not.toContain(secret);
		}
	});

	// Runs after the fixtures above: together they must exercise every id, so
	// no check is left whose parity was never compared.
	it('covers every check id across the fixtures', () => {
		expect([...seen].sort()).toEqual([...DOCTOR_CHECK_IDS].sort());
	});
});

describe('doctor --json — report contents', () => {
	it('prints only the JSON document on stdout', async () => {
		install(FIXTURES['healthy']!);
		const { code, stdout } = await run(FIXTURES['healthy']!, true);
		expect(code).toBe(0);
		expect(() => JSON.parse(stdout)).not.toThrow();
		expect(stdout).not.toContain('\u001b[');
	});

	it('names each failure by stable id, subject and remediation', async () => {
		const { report } = await runBoth(FIXTURES['brokenMta']!);
		expect(
			report.checks.map((check) =>
				[check.status, check.id, check.subject, check.remediation].filter(Boolean).join(' ')
			)
		).toMatchInlineSnapshot(`
			[
			  "pass env.file",
			  "fail env.required LLM_API_KEY set_env_var",
			  "fail env.required LLM_PROVIDER set_env_var",
			  "pass send_path.credential MTA_API_URL",
			  "pass send_path.credential MTA_API_KEY",
			  "fail mta.queue_store check_mta",
			  "fail mta.worker check_mta",
			  "fail mta.dns check_mta",
			  "fail mta.circuit_breaker check_ip_reputation",
			  "fail mta.identity 192.0.2.10 fix_reverse_dns",
			  "fail mta.queue_leak report_queue_leak",
			  "fail mta.tcp25 192.0.2.10 unblock_outbound_smtp",
			  "fail mta.sending_ips configure_sending_ips",
			  "fail mta.ip_audit 192.0.2.10 replace_or_delist_ip",
			  "fail compose.override run_setup",
			  "pass compose.services",
			  "fail containers.health web inspect_container",
			  "fail version.drift web recreate_containers",
			  "fail version.drift recreate_containers",
			]
		`);
		expect(report.checks[0]).toEqual({
			id: 'env.file',
			component: 'config',
			status: 'pass',
			severity: 'error',
			message: `.env file present at ${join(dir, '.env')}`,
		});
	});

	it('redacts a URL password and a secret pasted into a plain variable', async () => {
		const unreachable = await runBoth(FIXTURES['unreachable']!);
		const health = unreachable.report.checks.find((check) => check.id === 'mta.health');
		expect(health?.message).toContain('http://[redacted]@mta:3100/health');

		const mixup = await runBoth(FIXTURES['providerMixup']!);
		expect(
			mixup.report.checks.find((check) => check.id === 'send_path.provider')?.message
		).toContain('EMAIL_PROVIDER="[redacted]"');
	});
});
