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
const DEEP_SECRET = 'private/token+end';
const encodeRounds = (text: string, rounds: number) => {
	let out = text;
	for (let round = 0; round < rounds; round++) out = encodeURIComponent(out);
	return out;
};
const FIVE_ROUNDS = encodeRounds(DEEP_SECRET, 5);
// Four layers where the first percent-encodes every byte.
// Every byte percent-escaped: no exact form, and the first layer of the next two.
const FULL_BYTES = [...Buffer.from(DEEP_SECRET)]
	.map((byte) => `%${byte.toString(16).padStart(2, '0')}`)
	.join('');
const FOUR_ROUNDS_FULL_BYTES = encodeRounds(FULL_BYTES, 3);
const BASE64_SECRET = Buffer.from(DEEP_SECRET).toString('base64');
const SPLIT_BASE64 = (gap: string) => `${BASE64_SECRET.slice(0, 8)}${gap}${BASE64_SECRET.slice(8)}`;
// ß folds to its capital ẞ; the combining acute must stay attached.
const ESZETT = 'Straße-pa\u0301ss-42';
// Compatibility characters whose NFKC form is a space plus a combining mark,
// echoed in that form, and the reverse: [fixture, secret, echo].
const NFKC_CASES = [
	['nfkcDiaeresis', 'pw\u00a8secret42', 'pw\u00a8secret42'.normalize('NFKC')],
	['nfkcTilde', 'pw\u02dcsecret42', 'pw\u02dcsecret42'.normalize('NFKC')],
	['nfkcReverse', 'pw\u00a8secret42'.normalize('NFKC'), 'pw\u00a8secret42'],
] as const;
// Case variants only full folding after NFKC reaches: [fixture, secret, echo].
const FOLD_CASES = [
	['foldMixedEszett', 'Straße-paß-42', 'STRASSE-PAß-42'],
	['foldCapitalEszett', 'Straẞe-páss-42', 'STRASSE-PÁSS-42'],
	['foldDecomposedAccent', 'p\u00e1ss-word-42', 'pa\u0301ss-word-42'],
] as const;
// The same text again, for the fixture where a second secret (`25`) is masked
// inside its escapes and splits them.
const THREE_ROUNDS_OVER_FULL_BYTES = FOUR_ROUNDS_FULL_BYTES;

interface Fixture {
	env: string;
	flags?: string;
	override?: boolean;
	/** stdout of `docker compose ps`, or an error when docker cannot run. */
	compose: string | Error;
	fetch?: (url: string, init?: RequestInit) => Response;
	/** Values from this fixture's `.env` that must appear in neither output. */
	secrets?: string[];
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
			// A password holding an `@`: userinfo runs to the LAST `@`.
			`MTA_API_URL=http://admin:${URL_PASSWORD}@second@mta:3100`,
			`MTA_API_KEY=${MTA_KEY}`,
		].join('\n'),
		flags: '{ not json',
		compose: new Error('spawn docker ENOENT'),
		// The runtime error echoes the raw URL, credentials and all.
		fetch: (url) => {
			throw new Error(`connect ECONNREFUSED ${url}`);
		},
		secrets: [`${URL_PASSWORD}@second`],
	},
	shortCredential: {
		// A three-character key, pasted into the provider variable too.
		env: ['EMAIL_PROVIDER=q~z', 'RESEND_API_KEY=q~z'].join('\n'),
		flags: JSON.stringify({ campaigns: true }),
		compose: '',
		secrets: ['q~z'],
	},
	encodedQuery: {
		env: [
			'EMAIL_PROVIDER=mta',
			'MTA_API_KEY=private/token',
			'MTA_API_URL=http://mta:3100/?api_key=private%2Ftoken#frag-secret-77',
		].join('\n'),
		flags: JSON.stringify({ campaigns: true }),
		compose: '',
		fetch: (url) => {
			throw new Error(`connect ECONNREFUSED ${url}`);
		},
		secrets: ['private/token', 'private%2Ftoken', 'frag-secret-77'],
	},
	connectionStrings: {
		env: [
			'DATABASE_URL=postgres://owlat:db-pass-123@db:5432/owlat',
			'REDIS_URL=redis://:redis-pass-456@redis:6379',
		].join('\n'),
		compose: composeRows([
			{
				Service: 'worker',
				State: 'exited',
				// Docker's status line is runtime data and may echo configuration.
				Status:
					'Exited (1) postgres://owlat:db-pass-123@db:5432/owlat refused; NOAUTH redis-pass-456',
				Image: 'ghcr.io/wolvesdotink/worker:0.6.15',
			},
		]),
		secrets: ['db-pass-123', 'redis-pass-456'],
	},
	mixedCaseQuery: {
		env: [
			'EMAIL_PROVIDER=mta',
			'MTA_API_URL=http://mta:3100/?token=private%2ftoken%2Bend&alt=private+token',
		].join('\n'),
		flags: JSON.stringify({ campaigns: true }),
		compose: '',
		fetch: (url) => {
			throw new Error(`connect ECONNREFUSED ${url}`);
		},
		secrets: ['private/token+end', 'private%2ftoken%2Bend', 'private+token', 'private token'],
	},
	productNameSecret: {
		// Secrets equal to the product name, in both cases: the drift findings'
		// key name and remediation command are code-owned and stay intact.
		env: ['PRIVATE_KEY=OWLAT', 'DKIM_PRIVATE_KEY=owlat', 'OWLAT_VERSION=0.6.15'].join('\n'),
		compose: composeRows([
			{
				Service: 'web',
				State: 'running',
				Status: 'Up 2 hours',
				Image: 'ghcr.io/wolvesdotink/web:0.6.14',
			},
		]),
	},
	deepEncoded: {
		env: ['EMAIL_PROVIDER=mta', 'MTA_API_URL=http://mta:3100', `MTA_API_KEY=${DEEP_SECRET}`].join(
			'\n'
		),
		flags: JSON.stringify({ campaigns: true }),
		compose: '',
		fetch: () => {
			throw new Error(`upstream said ${FIVE_ROUNDS} and ${FOUR_ROUNDS_FULL_BYTES}`);
		},
		secrets: [DEEP_SECRET, FIVE_ROUNDS, FOUR_ROUNDS_FULL_BYTES],
	},
	literalMarkerUrl: {
		env: [
			'EMAIL_PROVIDER=mta',
			'MTA_API_URL=http://mta:3100/?token=private[redacted]%2ftoken',
		].join('\n'),
		flags: JSON.stringify({ campaigns: true }),
		compose: '',
		fetch: (url) => {
			throw new Error(`connect ECONNREFUSED ${url}`);
		},
		secrets: ['private[redacted]%2ftoken', 'private[redacted]/token'],
	},
	splitEscapes: {
		env: [
			'EMAIL_PROVIDER=mta',
			'MTA_API_URL=http://mta:3100',
			`MTA_API_KEY=${DEEP_SECRET}`,
			'SPLIT_KEY=25',
		].join('\n'),
		flags: JSON.stringify({ campaigns: true }),
		compose: '',
		fetch: () => {
			throw new Error(`upstream said ${THREE_ROUNDS_OVER_FULL_BYTES}`);
		},
		secrets: [DEEP_SECRET, FULL_BYTES, THREE_ROUNDS_OVER_FULL_BYTES],
	},
	invalidUtf8: {
		env: ['EMAIL_PROVIDER=mta', 'MTA_API_URL=http://mta:3100', `MTA_API_KEY=${DEEP_SECRET}`].join(
			'\n'
		),
		flags: JSON.stringify({ campaigns: true }),
		compose: '',
		fetch: () => {
			throw new Error(`upstream said %FF${FULL_BYTES}`);
		},
		secrets: [DEEP_SECRET, FULL_BYTES],
	},
	plainError: {
		env: ['EMAIL_PROVIDER=mta', 'MTA_API_URL=http://mta:3100', `MTA_API_KEY=${DEEP_SECRET}`].join(
			'\n'
		),
		flags: JSON.stringify({ campaigns: true }),
		compose: '',
		fetch: () => {
			throw new Error('connect ECONNREFUSED 10.0.0.1:3100');
		},
	},
	unrelatedEscape: {
		env: ['EMAIL_PROVIDER=mta', 'MTA_API_URL=http://mta:3100', `MTA_API_KEY=${DEEP_SECRET}`].join(
			'\n'
		),
		flags: JSON.stringify({ campaigns: true }),
		compose: '',
		fetch: () => {
			throw new Error('GET /files/annual%20report.pdf returned 404');
		},
	},
	dottedCapitalI: {
		env: [
			'EMAIL_PROVIDER=mta',
			'MTA_API_URL=http://mta:3100',
			'MTA_API_KEY=İstanbul-password-42',
		].join('\n'),
		flags: JSON.stringify({ campaigns: true }),
		compose: '',
		fetch: () => {
			throw new Error('auth rejected İstanbul-password-42');
		},
		secrets: ['İstanbul-password-42'],
	},
	eszettCombining: {
		env: ['EMAIL_PROVIDER=mta', 'MTA_API_URL=http://mta:3100', `MTA_API_KEY=${ESZETT}`].join('\n'),
		flags: JSON.stringify({ campaigns: true }),
		compose: '',
		fetch: () => {
			throw new Error(`auth rejected ${ESZETT} and STRAẞE-PA\u0301SS-42`);
		},
		secrets: [ESZETT, 'STRAẞE-PA\u0301SS-42'],
	},
	...Object.fromEntries(
		FOLD_CASES.map(([name, secret, echo]): [string, Fixture] => [
			name,
			{
				env: ['EMAIL_PROVIDER=mta', 'MTA_API_URL=http://mta:3100', `MTA_API_KEY=${secret}`].join(
					'\n'
				),
				flags: JSON.stringify({ campaigns: true }),
				compose: '',
				fetch: () => {
					throw new Error(`auth rejected ${echo}`);
				},
				secrets: [secret, echo],
			},
		])
	),
	...Object.fromEntries(
		(
			[
				['splitBase64Space', ' '],
				['splitBase64Tab', '\t'],
				['splitBase64Lf', '\n'],
				['splitBase64Crlf', '\r\n'],
			] as const
		).map(([name, gap]): [string, Fixture] => [
			name,
			{
				env: [
					'EMAIL_PROVIDER=mta',
					'MTA_API_URL=http://mta:3100',
					`MTA_API_KEY=${DEEP_SECRET}`,
				].join('\n'),
				flags: JSON.stringify({ campaigns: true }),
				compose: '',
				fetch: () => {
					throw new Error(`Authorization: ${SPLIT_BASE64(gap)}`);
				},
				secrets: [DEEP_SECRET, BASE64_SECRET],
			},
		])
	),
	percentSecret: {
		env: [
			'EMAIL_PROVIDER=mta',
			'MTA_API_URL=http://mta:3100',
			`MTA_API_KEY=${DEEP_SECRET}`,
			'PERCENT_KEY=%',
		].join('\n'),
		flags: JSON.stringify({ campaigns: true }),
		compose: '',
		fetch: () => {
			throw new Error(`upstream said ${FULL_BYTES}`);
		},
		secrets: [DEEP_SECRET, FULL_BYTES],
	},
	sigmaFold: {
		env: ['EMAIL_PROVIDER=mta', 'MTA_API_URL=http://mta:3100', 'MTA_API_KEY=StraßeΟΣ'].join('\n'),
		flags: JSON.stringify({ campaigns: true }),
		compose: '',
		fetch: () => {
			throw new Error('invalid credential STRASSEΟΣ rejected');
		},
		secrets: ['StraßeΟΣ', 'STRASSEΟΣ'],
	},
	finalSigmaMidSentence: {
		// ß expands to SS, so masking cannot catch it and the fold check must:
		// the secret's final ς and the echo's mid-sentence Σ fold alike.
		env: ['EMAIL_PROVIDER=mta', 'MTA_API_URL=http://mta:3100', 'MTA_API_KEY=ßκωδικός'].join('\n'),
		flags: JSON.stringify({ campaigns: true }),
		compose: '',
		fetch: () => {
			throw new Error('login SSΚΩΔΙΚΌΣ failed twice');
		},
		secrets: ['ßκωδικός', 'SSΚΩΔΙΚΌΣ'],
	},
	splitAuditParts: {
		env: ['EMAIL_PROVIDER=mta', 'MTA_API_URL=http://mta:3100', 'REDIS_PASSWORD=private token'].join(
			'\n'
		),
		flags: JSON.stringify({ campaigns: true }),
		compose: '',
		fetch: (url) =>
			Response.json(
				url.endsWith('/ip-audit')
					? {
							audits: [
								{ ip: '192.0.2.10', verdict: 'clean', headline: 'private', nextAction: 'token' },
							],
						}
					: healthyMta
			),
		secrets: ['private token'],
	},
	splitAcrossCopy: {
		env: [
			'EMAIL_PROVIDER=mta',
			'MTA_API_URL=http://mta:3100',
			'MTA_API_KEY=unreachable (pw-77',
		].join('\n'),
		flags: JSON.stringify({ campaigns: true }),
		compose: '',
		fetch: () => {
			throw new Error('pw-77 refused');
		},
		secrets: ['unreachable (pw-77'],
	},
	...Object.fromEntries(
		NFKC_CASES.map(([name, secret, echo]): [string, Fixture] => [
			name,
			{
				env: [
					'EMAIL_PROVIDER=mta',
					'MTA_API_URL=http://mta:3100',
					`MTA_API_KEY=${JSON.stringify(secret)}`,
				].join('\n'),
				flags: JSON.stringify({ campaigns: true }),
				compose: '',
				fetch: () => {
					throw new Error(`auth rejected ${echo}`);
				},
				secrets: [secret, echo],
			},
		])
	),
	commonWordSecret: {
		// A secret equal to a word in key names and subjects: identifiers stay intact.
		env: ['LLM_API_KEY=LLM', 'OWLAT_VERSION=0.6.15'].join('\n'),
		flags: JSON.stringify({ ai: true }),
		compose: '',
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
		for (const secret of [...SECRETS, ...(FIXTURES[name]!.secrets ?? [])]) {
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

	/** The message of the first `id` check, in JSON and as the text line printed it. */
	async function messageOf(fixture: string, id: string) {
		const { text, report } = await runBoth(FIXTURES[fixture]!);
		const message = report.checks.find((check) => check.id === id)?.message ?? '';
		const line = checklist(text.stdout).find(([, row]) => row.endsWith(message))?.[1];
		expect(line).toBeDefined();
		return message;
	}

	it('prints a configured URL without userinfo, even when the password holds an @', async () => {
		expect(await messageOf('unreachable', 'mta.health')).toBe(
			'http://mta:3100/health is unreachable ' +
				'(connect ECONNREFUSED http://admin:[redacted]@mta:3100/health)'
		);
	});

	it('prints a configured URL without its query or fragment, and withholds an escaped echo', async () => {
		expect(await messageOf('encodedQuery', 'mta.health')).toBe(
			'[redacted] is unreachable ([redacted])'
		);
	});

	it('redacts a credential pasted into a displayable variable, however short', async () => {
		expect(await messageOf('providerMixup', 'send_path.provider')).toContain(
			'EMAIL_PROVIDER="[redacted]"'
		);
		expect(await messageOf('shortCredential', 'send_path.provider')).toContain(
			'EMAIL_PROVIDER="[redacted]"'
		);
	});

	it('redacts connection-string passwords that runtime data echoes', async () => {
		expect(await messageOf('connectionStrings', 'containers.health')).toBe(
			'container "worker" is not running (exited) — Exited (1) ' +
				'postgres://owlat:[redacted]@db:5432/owlat refused; NOAUTH [redacted]'
		);
	});

	it('withholds a runtime part echoing a mixed-case escaped query secret', async () => {
		expect(await messageOf('mixedCaseQuery', 'mta.health')).toBe(
			'[redacted] is unreachable ([redacted])'
		);
	});

	it('masks a secret whose lower-case form changes length', async () => {
		expect(await messageOf('dottedCapitalI', 'mta.health')).toBe(
			'http://mta:3100/health is unreachable (auth rejected [redacted])'
		);
	});

	it('masks a secret with ß and a combining character', async () => {
		expect(await messageOf('eszettCombining', 'mta.health')).toBe(
			'http://mta:3100/health is unreachable (auth rejected [redacted] and [redacted])'
		);
	});

	it.each(FOLD_CASES.map(([name]) => name))(
		'withholds a runtime part echoing a full-case-folded or renormalised secret: %s',
		async (fixture) => {
			expect(await messageOf(fixture, 'mta.health')).toBe('[redacted] is unreachable ([redacted])');
		}
	);

	it.each(['splitBase64Space', 'splitBase64Tab', 'splitBase64Lf', 'splitBase64Crlf'])(
		'withholds a runtime part holding whitespace-split base64 of a secret: %s',
		async (fixture) => {
			expect(await messageOf(fixture, 'mta.health')).toBe('[redacted] is unreachable ([redacted])');
		}
	);

	it('withholds a runtime part with a % even when a secret mask would swallow it', async () => {
		expect(await messageOf('percentSecret', 'mta.health')).toBe(
			'[redacted] is unreachable ([redacted])'
		);
	});

	it('drops a runtime part whose escapes another secret splits apart', async () => {
		expect(await messageOf('splitEscapes', 'mta.health')).toBe(
			'[redacted] is unreachable ([redacted])'
		);
	});

	it('drops a runtime part where invalid UTF-8 precedes an encoded secret', async () => {
		expect(await messageOf('invalidUtf8', 'mta.health')).toBe(
			'[redacted] is unreachable ([redacted])'
		);
	});

	it('keeps a plain runtime error with no escape and no secret readable', async () => {
		expect(await messageOf('plainError', 'mta.health')).toBe(
			'http://mta:3100/health is unreachable (connect ECONNREFUSED 10.0.0.1:3100)'
		);
	});

	// Intended trade: any escape outside the masks drops the part.
	it('drops a runtime error that holds an unrelated escape', async () => {
		expect(await messageOf('unrelatedEscape', 'mta.health')).toBe(
			'[redacted] is unreachable ([redacted])'
		);
	});

	it('drops a runtime part encoded deeper than the decoding rounds reach', async () => {
		expect(await messageOf('deepEncoded', 'mta.health')).toBe(
			'[redacted] is unreachable ([redacted])'
		);
	});

	it('drops a runtime part whose credential contains a literal [redacted]', async () => {
		expect(await messageOf('literalMarkerUrl', 'mta.health')).toBe(
			'[redacted] is unreachable ([redacted])'
		);
	});

	it.each(['sigmaFold', 'finalSigmaMidSentence'])(
		'withholds a runtime part echoing a sigma secret in another case: %s',
		async (fixture) => {
			expect(await messageOf(fixture, 'mta.health')).toBe('[redacted] is unreachable ([redacted])');
		}
	);

	it.each(NFKC_CASES.map(([name]) => name))(
		'withholds a runtime part echoing a secret across NFKC whitespace: %s',
		async (fixture) => {
			expect(await messageOf(fixture, 'mta.health')).toBe('[redacted] is unreachable ([redacted])');
		}
	);

	it('withholds every runtime part when adjacent parts rebuild a secret', async () => {
		expect(await messageOf('splitAuditParts', 'mta.ip_audit')).toBe(
			'IP audit for [redacted]: [redacted]'
		);
	});

	it('withholds every runtime part when a secret spans a part and the copy beside it', async () => {
		expect(await messageOf('splitAcrossCopy', 'mta.health')).toBe(
			'[redacted] is unreachable ([redacted])'
		);
	});

	it('keeps key names and remediation commands in drift findings intact', async () => {
		const { report } = await runBoth(FIXTURES['productNameSecret']!);
		// The copy itself contains the secret word, so the whole-message check
		// withholds the runtime values (safe over-redaction); the code-owned key
		// name, product name and command still print intact.
		expect(report.checks.filter((check) => check.id === 'version.drift')).toMatchObject([
			{
				subject: 'web',
				message:
					'container "[redacted]" runs [redacted] but OWLAT_VERSION is [redacted] — ' +
					'the configured and running versions have diverged',
			},
			{
				message:
					'1 of 1 Owlat container(s) were never recreated for [redacted]. ' +
					'Run `owlat start` (docker compose up -d) to apply the configured version.',
			},
		]);
	});

	it('never redacts an identifier that equals a secret', async () => {
		const { report } = await runBoth(FIXTURES['commonWordSecret']!);
		const provider = report.checks.find((check) => check.subject === 'LLM_PROVIDER');
		expect(provider).toMatchObject({
			id: 'env.required',
			status: 'fail',
			message: 'LLM_PROVIDER is set (required by an active feature)',
		});
		expect(report.checks.find((check) => check.subject === 'LLM_API_KEY')?.message).toBe(
			'LLM_API_KEY is set (required by an active feature)'
		);
	});
});
