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
	it('keeps the parts of a nested text', () => {
		const inner = doctorText`is not running (${'exited'})`;
		const text = doctorText`container ${'web'} ${inner}`;
		expect(text.render((part) => `<${part}>`)).toBe('container <web> is not running (<exited>)');
	});

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

	it('masks mixed-case and form-encoded echoes of a configured query secret', () => {
		// Configured query values: `URL` decodes them, so the secrets are the
		// decoded strings, while the echo carries them encoded.
		const redact = createDoctorRedactor({
			MTA_API_URL: 'http://mta:3100/?token=private%2ftoken%2Bend&alt=private+token',
		});
		// Mixed-case escapes: the encoded form matches case-insensitively.
		expect(redact('connect ECONNREFUSED http://mta:3100/?token=private%2ftoken%2Bend')).toBe(
			'connect ECONNREFUSED http://mta:3100/?token=[redacted]'
		);
		// `+` for a space (form encoding).
		expect(redact('GET /?alt=private+token failed')).toBe('GET /?alt=[redacted] failed');
	});

	it('masks any case of a key value, and drops a part holding a double escape', () => {
		const redact = createDoctorRedactor({ MTA_API_KEY: 'a/b+c' });
		expect(redact('key=a%2fb%2Bc')).toBe('key=[redacted]');
		expect(redact('key=A%2FB%2BC')).toBe('key=[redacted]');
		expect(redact('key=A/B+C')).toBe('key=[redacted]');
		expect(redact('key=a%252Fb%252Bc')).toBe('[redacted]');
	});

	it('drops a part whose escapes the masks of another secret split apart', () => {
		const redact = createDoctorRedactor({ A_KEY: 'private/token+end', B_KEY: '25' });
		const fullyEncoded = [...Buffer.from('private/token+end')]
			.map((byte) => `%${byte.toString(16).padStart(2, '0')}`)
			.join('');
		let threeMore = fullyEncoded;
		for (let round = 0; round < 3; round++) threeMore = encodeURIComponent(threeMore);
		expect(redact(`upstream said ${threeMore}`)).toBe('[redacted]');
	});

	it('drops a part where invalid UTF-8 makes an escape run undecodable', () => {
		const redact = createDoctorRedactor({ A_KEY: 'private/token+end' });
		const fullyEncoded = [...Buffer.from('private/token+end')]
			.map((byte) => `%${byte.toString(16).padStart(2, '0')}`)
			.join('');
		expect(redact(`upstream said %FF${fullyEncoded}`)).toBe('[redacted]');
	});

	it('leaves a plain error with no escape and no secret fully readable', () => {
		const redact = createDoctorRedactor({ A_KEY: 'private/token+end' });
		expect(redact('connect ECONNREFUSED 10.0.0.1:3100 (after 3 attempts)')).toBe(
			'connect ECONNREFUSED 10.0.0.1:3100 (after 3 attempts)'
		);
	});

	// Intended: an escape outside the masks could be any encoding of a secret,
	// so an error that merely contains an unrelated `%20` loses its detail too.
	it('drops a part with an unrelated escape even when no secret is in it', () => {
		const redact = createDoctorRedactor({ A_KEY: 'private/token+end' });
		expect(redact('GET /files/annual%20report.pdf returned 404')).toBe('[redacted]');
	});

	it('keeps the readable rest of a part when exact replacement removed every secret', () => {
		const redact = createDoctorRedactor({ MTA_API_KEY: 'private/token' });
		expect(redact('api_key=private%2Ftoken refused')).toBe('api_key=[redacted] refused');
	});

	it('drops a whole part encoded deeper than the decoding rounds reach', () => {
		const redact = createDoctorRedactor({ MTA_API_KEY: 'private/token+end' });
		let fiveRounds = 'private/token+end';
		for (let round = 0; round < 5; round++) fiveRounds = encodeURIComponent(fiveRounds);
		expect(redact(`upstream said ${fiveRounds}`)).toBe('[redacted]');
		// Four layers where the first percent-encodes every byte.
		let fourRounds = [...Buffer.from('private/token+end')]
			.map((byte) => `%${byte.toString(16).padStart(2, '0')}`)
			.join('');
		for (let round = 0; round < 3; round++) fourRounds = encodeURIComponent(fourRounds);
		expect(redact(`upstream said ${fourRounds}`)).toBe('[redacted]');
	});

	it('treats a literal [redacted] in runtime text as ordinary text', () => {
		// The configured credential itself contains the marker text.
		const redact = createDoctorRedactor({
			MTA_API_URL: 'http://mta:3100/?token=private[redacted]%2ftoken',
		});
		expect(redact('connect ECONNREFUSED http://mta:3100/?token=private[redacted]%2ftoken')).toBe(
			'[redacted]'
		);
		// And a marker or a private-use character in input never fakes a replacement.
		const plain = createDoctorRedactor({ MTA_API_KEY: 'private/token' });
		expect(plain('[redacted] \uE000 private/token')).toBe('[redacted] \uE000 [redacted]');
		expect(plain('private\uE000/token')).toBe('private\uE000/token');
	});

	it('drops a whole part when another secret covers half of an encoded occurrence', () => {
		// `iva` (exact) sits inside a mixed-case occurrence of the longer secret.
		const redact = createDoctorRedactor({ A_KEY: 'private/token', B_KEY: 'iva' });
		expect(redact('PrivaTE%2ftoken')).toBe('[redacted]');
		// Exact occurrences of both are simply masked.
		expect(redact('private/token and iva')).toBe('[redacted] and [redacted]');
	});

	it('replaces in one pass, so a short secret cannot match inside a replacement', () => {
		const redact = createDoctorRedactor({ A_KEY: 'abcdefgh', B_KEY: 'act', C_KEY: 'd' });
		expect(redact('x abcdefgh y act')).toBe('x [redacted] y [redacted]');
	});

	it('is a no-op without secrets', () => {
		expect(createDoctorRedactor({ EMAIL_PROVIDER: 'mta' })('MTA is up')).toBe('MTA is up');
	});
});
