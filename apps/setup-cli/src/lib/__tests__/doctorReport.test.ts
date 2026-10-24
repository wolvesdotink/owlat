import { describe, expect, it } from 'vitest';
import {
	DOCTOR_CHECK_IDS,
	DoctorReportBuilder,
	renderDoctorCheckLine,
	renderDoctorSummary,
	type DoctorCheck,
} from '../doctorReport';
import { doctorText, trusted } from '../doctorText';

// eslint-disable-next-line no-control-regex -- ANSI colour escapes start with ESC
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

describe('doctor report — recording', () => {
	it('redacts the untrusted parts of a message, never its identifiers', () => {
		const builder = new DoctorReportBuilder();
		// A secret equal to a word that also appears in a key name and a subject.
		builder.useEnv({ SMTP_RELAY_PASSWORD: 'SMTP' });
		builder.record({
			check: 'env.required',
			subject: 'SMTP_RELAY_HOST',
			ok: false,
			message: doctorText`${trusted('SMTP_RELAY_HOST')} is set (runtime said: ${'SMTP'})`,
		});
		expect(builder.checks[0]).toMatchObject({
			subject: 'SMTP_RELAY_HOST',
			message: 'SMTP_RELAY_HOST is set (runtime said: [redacted])',
		});
	});

	it('records only code-owned text once runtime text is withheld', () => {
		const builder = new DoctorReportBuilder();
		builder.useEnv({});
		builder.withholdRuntimeText();
		builder.record({
			check: 'mta.health',
			ok: false,
			message: doctorText`MTA at ${trusted('http://mta:3100/')} answered: ${'queue for Alice Smith stuck'}`,
		});
		expect(builder.checks[0]!.message).toBe('MTA at http://mta:3100/ answered: [redacted]');
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
		builder.record({ check: 'env.file', ok: true, message: doctorText`a` });
		const passing = builder.build(['campaigns', 'inbox'], new Date(0));
		expect(stripAnsi(renderDoctorSummary(passing))).toBe(
			'All checks passed. Active features: campaigns, inbox'
		);
		builder.record({ check: 'compose.cli', ok: false, message: doctorText`b` });
		const failing = builder.build([], new Date(0));
		expect(failing.summary).toEqual({ total: 2, passed: 1, failed: 1 });
		expect(stripAnsi(renderDoctorSummary(failing))).toBe(
			'1 check(s) failed. Run `owlat-setup config` to fix.'
		);
	});
});
