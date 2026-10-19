import { describe, expect, it } from 'vitest';
import { createDoctorRedactor, doctorText, envValue, trusted, urlValue } from '../doctorText';

describe('doctor text — sanitizers', () => {
	it('prints a URL as scheme, host, port and path only', () => {
		expect(urlValue('https://user:pa55@mta.owlat.example:3100/health?api_key=k#frag')).toBe(
			'https://mta.owlat.example:3100/health'
		);
		expect(urlValue('redis://:pa55@redis:6379/0')).toBe('redis://redis:6379/0');
		expect(urlValue('postgres://owlat:db-pass@db:5432/owlat?sslmode=require')).toBe(
			'postgres://db:5432/owlat'
		);
	});

	it('drops the whole userinfo when the password holds an @', () => {
		expect(urlValue('http://admin:first@second@mta:3100/health')).toBe('http://mta:3100/health');
	});

	it('prints an unparseable URL as redacted, not as written', () => {
		expect(urlValue('not a url with secret-in-it')).toBe('[redacted]');
	});

	it('echoes only allow-listed configured values', () => {
		expect(envValue('EMAIL_PROVIDER', 'sendgrid')).toBe('sendgrid');
		expect(envValue('OWLAT_VERSION', '0.6.15')).toBe('0.6.15');
		expect(envValue('MTA_API_URL', 'http://mta:3100')).toBe('[redacted]');
		expect(envValue('SOME_SETTING', 'value')).toBe('[redacted]');
	});
});

describe('doctor text — trusted and untrusted parts', () => {
	it('keeps literals, trusted values and counts out of the redactor', () => {
		const text = doctorText`${trusted('SMTP_RELAY_HOST')} saw ${3} rows: ${'SMTP down'}`;
		expect(text.render(() => 'X')).toBe('SMTP_RELAY_HOST saw 3 rows: X');
		expect(String(text)).toBe('SMTP_RELAY_HOST saw 3 rows: SMTP down');
	});
});

describe('doctor text — known-secret pass', () => {
	it('redacts a credential however short, including one equal to a common word', () => {
		const redact = createDoctorRedactor({ RESEND_API_KEY: 'abc', REDIS_PASSWORD: 'running' });
		expect(redact('EMAIL_PROVIDER="abc"')).toBe('EMAIL_PROVIDER="[redacted]"');
		expect(redact('container is running')).toBe('container is [redacted]');
	});

	it('redacts the value of every secret-shaped key, never a plain one', () => {
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

	it('redacts URL-encoded and base64 forms of a secret', () => {
		const redact = createDoctorRedactor({ MTA_API_KEY: 'private/token' });
		expect(redact('GET http://mta:3100/health?api_key=private%2Ftoken')).toBe(
			'GET http://mta:3100/health?api_key=[redacted]'
		);
		expect(redact('api_key=private%2ftoken')).toBe('api_key=[redacted]');
		const base64 = Buffer.from('private/token').toString('base64');
		expect(redact(`Authorization: Basic ${base64}`)).toBe('Authorization: Basic [redacted]');
	});

	it('redacts the credential parts of any configured URL', () => {
		const redact = createDoctorRedactor({
			DATABASE_URL: 'postgres://owlat:db-pass@db:5432/owlat',
			REDIS_URL: 'redis://:redis-pass@redis:6379',
			MTA_API_URL: 'http://admin:first@second@mta:3100/?token=query-secret#frag-secret',
		});
		expect(redact('connect postgres://owlat:db-pass@db:5432 failed')).toBe(
			'connect postgres://owlat:[redacted]@db:5432 failed'
		);
		expect(redact('NOAUTH redis-pass')).toBe('NOAUTH [redacted]');
		expect(redact('http://admin:first@second@mta:3100/')).toBe('http://admin:[redacted]@mta:3100/');
		expect(redact('query-secret frag-secret')).toBe('[redacted] [redacted]');
	});

	it('treats a lone URL username as the credential', () => {
		const redact = createDoctorRedactor({
			PLUGIN_REPO_URL: 'https://ghp-token-123@git.example.com/r',
		});
		expect(redact('clone https://ghp-token-123@git.example.com/r failed')).toBe(
			'clone https://[redacted]@git.example.com/r failed'
		);
	});

	it('replaces in one pass, so a short secret cannot match inside a replacement', () => {
		const redact = createDoctorRedactor({ A_KEY: 'abcdefgh', B_KEY: 'act', C_KEY: 'd' });
		expect(redact('x abcdefgh y act')).toBe('x [redacted] y [redacted]');
	});

	it('is a no-op without secrets', () => {
		expect(createDoctorRedactor({ EMAIL_PROVIDER: 'mta' })('MTA is up')).toBe('MTA is up');
	});
});
