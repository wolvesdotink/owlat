import { describe, expect, it } from 'vitest';
import { VALUE_OPTIONS, cliOptionsFromArgv, parseArgv } from '../argv';

describe('parseArgv', () => {
	it('keeps an option value out of positional, after the arguments or before them', () => {
		for (const args of [
			['SITE_URL', 'https://mail.example.com', '--owlat-dir', '/srv/owlat'],
			['--owlat-dir', '/srv/owlat', 'SITE_URL', 'https://mail.example.com'],
			['SITE_URL', '--owlat-dir', '/srv/owlat', 'https://mail.example.com'],
		]) {
			const parsed = parseArgv(args);
			expect(parsed.positional).toEqual(['SITE_URL', 'https://mail.example.com']);
			expect(parsed.values.get('--owlat-dir')).toBe('/srv/owlat');
		}
	});

	it.each([...VALUE_OPTIONS])('consumes the value of %s in both forms', (option) => {
		expect(parseArgv(['KEY', option, 'option-value', 'VALUE'])).toEqual({
			flags: new Set(),
			values: new Map([[option, 'option-value']]),
			positional: ['KEY', 'VALUE'],
		});
		expect(parseArgv([`${option}=option-value`, 'KEY', 'VALUE'])).toEqual({
			flags: new Set(),
			values: new Map([[option, 'option-value']]),
			positional: ['KEY', 'VALUE'],
		});
	});

	it('takes the next token as the value even when it starts with dashes', () => {
		const parsed = parseArgv(['--password', '--not-a-flag', 'KEY']);
		expect(parsed.values.get('--password')).toBe('--not-a-flag');
		expect(parsed.flags.size).toBe(0);
		expect(parsed.positional).toEqual(['KEY']);
	});

	it('keeps only the text after the first = in --opt=value', () => {
		expect(parseArgv(['--password=a=b']).values.get('--password')).toBe('a=b');
		expect(parseArgv(['--owlat-dir=']).values.get('--owlat-dir')).toBe('');
	});

	it('treats a value option at the end as given without a value', () => {
		const parsed = parseArgv(['KEY', '--owlat-dir']);
		expect(parsed.values.has('--owlat-dir')).toBe(false);
		expect(parsed.positional).toEqual(['KEY']);
	});

	it('collects flags without taking the next token, and -y as a flag', () => {
		const parsed = parseArgv(['--web', 'ai', '-y', '--reset', 'on']);
		expect([...parsed.flags]).toEqual(['--web', '-y', '--reset']);
		expect(parsed.positional).toEqual(['ai', 'on']);
	});

	it('keeps single-dash tokens other than -y as positional', () => {
		expect(parseArgv(['KEY', '-1']).positional).toEqual(['KEY', '-1']);
	});
});

describe('cliOptionsFromArgv', () => {
	it('reads the install directory from --owlat-dir in either form before OWLAT_DIR', () => {
		const env = { OWLAT_DIR: '/from/env' };
		expect(cliOptionsFromArgv(['env', '--owlat-dir', '/from/flag'], env).owlatDir).toBe(
			'/from/flag'
		);
		expect(cliOptionsFromArgv(['--owlat-dir=/from/flag'], env).owlatDir).toBe('/from/flag');
		expect(cliOptionsFromArgv([], env).owlatDir).toBe('/from/env');
	});

	it('resolves the value options and flags, and keeps the raw args', () => {
		const args = [
			'--owlat-version',
			'1.2.3',
			'--config=answers.yaml',
			'--mode',
			'blank',
			'--email',
			'admin@example.com',
			'-y',
			'--build-local',
		];
		const opts = cliOptionsFromArgv(args, {});
		expect(opts).toMatchObject({
			owlatVersion: '1.2.3',
			configFile: 'answers.yaml',
			assumeYes: true,
			buildLocal: true,
			localImages: false,
			web: false,
			terminal: false,
			positional: [],
		});
		expect(opts.args).toBe(args);
	});

	it('takes the local-image switches from the environment too', () => {
		const opts = cliOptionsFromArgv([], { OWLAT_BUILD_LOCAL: '1', OWLAT_LOCAL_IMAGES: '1' });
		expect(opts.buildLocal).toBe(true);
		expect(opts.localImages).toBe(true);
	});
});
