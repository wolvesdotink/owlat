import { describe, expect, it } from 'vitest';
import { projectLogLineForExport } from '../logRedaction';

/**
 * The support bundle's log projection is an allowlist: whatever a line carries
 * that is not one of the fixed, shape-checked keys must not survive. Each case
 * seeds personal data where a real mail log puts it and asserts none of it is
 * anywhere in the projected record.
 */

const PII = [
	'marcel@example.com',
	'Marcel',
	'Invoice 4012',
	'mx1.example.net',
	'192.0.2.44',
	'sk_live_secret',
	'/home/marcel',
];

function expectNoPii(value: unknown): void {
	const text = JSON.stringify(value);
	for (const needle of PII) expect(text).not.toContain(needle);
}

describe('projectLogLineForExport', () => {
	it('keeps the allowlisted keys of a pino line and drops message, ids and unknown keys', () => {
		const line = JSON.stringify({
			level: 50,
			time: '2026-10-24T10:00:00.000Z',
			service: 'owlat-mta',
			pid: 7,
			event: 'delivery.smtp.failed',
			outcome: 'deferred',
			category: 'mailbox_full',
			durationMs: 1250,
			orgId: 'org_123',
			messageId: '<abc@mx1.example.net>',
			rcptTo: 'marcel@example.com',
			subject: 'Invoice 4012',
			host: 'mx1.example.net',
			ip: '192.0.2.44',
			msg: 'Delivery to marcel@example.com failed: 552 Marcel mailbox full (Invoice 4012)',
			err: {
				type: 'SmtpError',
				code: 'EENVELOPE',
				message: 'mx1.example.net said no to marcel@example.com',
				stack: 'SmtpError: ...\n    at /home/marcel/app.js:1:1',
			},
		});
		const projected = projectLogLineForExport(line);
		expect(projected).toMatchObject({
			format: 'json',
			level: 'error',
			service: 'owlat-mta',
			event: 'delivery.smtp.failed',
			outcome: 'deferred',
			category: 'mailbox_full',
			durationMs: 1250,
			errType: 'SmtpError',
			errCode: 'EENVELOPE',
			len: line.length,
		});
		expect(projected.msgDigest).toMatch(/^[0-9a-f]{12}$/);
		expect(projected.dropped).toBe(8);
		expectNoPii(projected);
	});

	it('drops an allowlisted key whose value does not have the promised shape', () => {
		const projected = projectLogLineForExport(
			JSON.stringify({
				level: 'info',
				event: 'Delivered to marcel@example.com',
				service: 'Marcel',
				outcome: 'sent to mx1.example.net',
				category: { name: 'Invoice 4012' },
				durationMs: 'slow',
				status: 'Marcel',
				err: { type: 'Error: marcel@example.com', code: 'ip 192.0.2.44' },
			})
		);
		expect(projected).toEqual({
			format: 'json',
			level: 'info',
			len: expect.any(Number),
			msgDigest: expect.any(String),
		});
	});

	it('maps pino levels and level names, and reads an HTTP status in range only', () => {
		expect(projectLogLineForExport('{"level":40}').level).toBe('warn');
		expect(projectLogLineForExport('{"level":"WARNING"}').level).toBe('warn');
		expect(projectLogLineForExport('{"severity":"error"}').level).toBe('error');
		expect(projectLogLineForExport('{"level":35}').level).toBeUndefined();
		expect(projectLogLineForExport('{"statusCode":502}').httpStatus).toBe(502);
		expect(projectLogLineForExport('{"status":7000}').httpStatus).toBeUndefined();
	});

	it('reads a logEvent line embedded in a Convex function log line', () => {
		const projected = projectLogLineForExport(
			`[CONVEX M(delivery:send)] [WARN] '{"event":"delivery.dispatch.refused","level":"warn","category":"forbidden","detail":{"to":"marcel@example.com"}}'`
		);
		expect(projected).toMatchObject({
			format: 'embedded-json',
			event: 'delivery.dispatch.refused',
			level: 'warn',
			category: 'forbidden',
			dropped: 1,
		});
		expectNoPii(projected);
	});

	it('reduces a plain-text line to its leading level word, length and digest', () => {
		const line =
			'2026-10-24T10:00:00Z ERROR smtp: Marcel <marcel@example.com> rejected by 192.0.2.44';
		const projected = projectLogLineForExport(line);
		expect(projected).toEqual({
			format: 'text',
			level: 'error',
			len: line.length,
			msgDigest: expect.stringMatching(/^[0-9a-f]{12}$/),
		});
		expectNoPii(projected);
		expect(projectLogLineForExport('[warn] disk almost full').level).toBe('warn');
		expect(projectLogLineForExport('Marcel wrote: hello').level).toBeUndefined();
	});

	it('treats malformed JSON and non-object JSON as text', () => {
		expect(projectLogLineForExport('{"msg": "marcel@example.com"').format).toBe('text');
		expect(projectLogLineForExport('["marcel@example.com"]').format).toBe('text');
		expect(projectLogLineForExport('"marcel@example.com"').format).toBe('text');
		expectNoPii(projectLogLineForExport('{"msg": "marcel@example.com"'));
	});

	it('gives the same message the same digest so repeats stay visible', () => {
		const a = projectLogLineForExport('{"level":50,"msg":"connect failed","time":1}');
		const b = projectLogLineForExport('{"level":50,"msg":"connect failed","time":2}');
		const c = projectLogLineForExport('{"level":50,"msg":"connect refused","time":2}');
		expect(a.msgDigest).toBe(b.msgDigest);
		expect(a.msgDigest).not.toBe(c.msgDigest);
	});
});
