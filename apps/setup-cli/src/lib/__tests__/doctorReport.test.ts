import { describe, expect, it } from 'vitest';
import {
	DOCTOR_CHECK_IDS,
	DoctorReportBuilder,
	createDoctorRedactor,
	renderDoctorCheckLine,
	renderDoctorSummary,
	type DoctorCheck,
} from '../doctorReport';

// eslint-disable-next-line no-control-regex
const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '');

describe('doctor report — stable ids', () => {
	// Scripts match on these. Renaming or removing one is a breaking change that
	// needs a schemaVersion bump; appending a new id is additive.
	it('keeps the published check ids', () => {
		expect(DOCTOR_CHECK_IDS).toMatchInlineSnapshot(`
			[
			  "env.file",
			  "flags.state",
			  "env.required",
			  "send_path.provider",
			  "send_path.credential",
			  "mta.health",
			  "mta.queue_store",
			  "mta.worker",
			  "mta.dns",
			  "mta.circuit_breaker",
			  "mta.identity",
			  "mta.queue_leak",
			  "mta.sending_ips",
			  "mta.tcp25",
			  "mta.ip_audit",
			  "compose.override",
			  "compose.services",
			  "compose.cli",
			  "containers.health",
			  "version.drift",
			]
		`);
	});
});

describe('doctor report — redaction', () => {
	it('replaces the value of every secret-shaped key', () => {
		const redact = createDoctorRedactor({
			MTA_API_KEY: 'key-value-1',
			INSTANCE_SECRET: 'secret-value-2',
			INSTANCE_SECRET_PREVIOUS: 'previous-value-3',
			REDIS_PASSWORD: 'password-value-4',
			TWILIO_AUTH_TOKEN: 'token-value-5',
			EMAIL_PROVIDER: 'mta',
		});
		expect(
			redact('key-value-1 secret-value-2 previous-value-3 password-value-4 token-value-5 mta')
		).toBe('[redacted] [redacted] [redacted] [redacted] [redacted] mta');
	});

	it('replaces a secret that contains another one whole', () => {
		const redact = createDoctorRedactor({ A_KEY: 'abcd', B_KEY: 'abcdefgh' });
		expect(redact('x abcdefgh y abcd')).toBe('x [redacted] y [redacted]');
	});

	it('leaves ordinary words alone when a secret is too short to be one', () => {
		const redact = createDoctorRedactor({ REDIS_PASSWORD: 'mta' });
		expect(redact('MTA queue store is connected via mta')).toBe(
			'MTA queue store is connected via mta'
		);
	});

	it('strips the credentials from any URL', () => {
		const redact = createDoctorRedactor({});
		expect(redact('https://user:pa55@mta.owlat.example:3100/health is unreachable')).toBe(
			'https://[redacted]@mta.owlat.example:3100/health is unreachable'
		);
		expect(redact('redis://:pa55@redis:6379')).toBe('redis://[redacted]@redis:6379');
	});

	it('redacts subjects as well as messages', () => {
		const builder = new DoctorReportBuilder();
		builder.useEnv({ MTA_API_KEY: 'key-value-1' });
		builder.record({ check: 'mta.tcp25', subject: 'key-value-1', ok: true, message: 'ok' });
		expect(builder.checks[0]?.subject).toBe('[redacted]');
	});
});

describe('doctor report — text rendering', () => {
	const check = (overrides: Partial<DoctorCheck>): DoctorCheck => ({
		id: 'env.file',
		component: 'config',
		status: 'pass',
		severity: 'error',
		message: 'message',
		...overrides,
	});

	it('keeps the checklist prefix each component has always printed', () => {
		expect(stripAnsi(renderDoctorCheckLine(check({})))).toBe('✓ message');
		expect(stripAnsi(renderDoctorCheckLine(check({ component: 'send_path' })))).toBe(
			'✓ SEND PATH: message'
		);
		expect(stripAnsi(renderDoctorCheckLine(check({ component: 'mta', status: 'fail' })))).toBe(
			'✗ SEND PATH: message'
		);
		expect(stripAnsi(renderDoctorCheckLine(check({ component: 'containers' })))).toBe(
			'✓ CONTAINERS: message'
		);
		expect(stripAnsi(renderDoctorCheckLine(check({ component: 'version' })))).toBe(
			'✓ VERSION: message'
		);
	});

	it('summarises the run', () => {
		const builder = new DoctorReportBuilder();
		builder.record({ check: 'env.file', ok: true, message: 'a' });
		const passing = builder.build(['campaigns', 'inbox'], new Date(0));
		expect(stripAnsi(renderDoctorSummary(passing))).toBe(
			'All checks passed. Active features: campaigns, inbox'
		);
		builder.record({ check: 'compose.cli', ok: false, message: 'b' });
		const failing = builder.build([], new Date(0));
		expect(failing.summary).toEqual({ total: 2, passed: 1, failed: 1 });
		expect(stripAnsi(renderDoctorSummary(failing))).toBe(
			'1 check(s) failed. Run `owlat-setup config` to fix.'
		);
	});
});
