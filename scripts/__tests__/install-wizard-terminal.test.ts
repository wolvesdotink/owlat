/**
 * install.sh attaches the setup wizard to a terminal unless the run answers
 * every question up front. These cases run the real `wizard_answers_up_front`
 * under install.sh's shell options: an empty config path is no config file,
 * as scripts/owlat treats it.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const install = readFileSync(join(import.meta.dirname, '../../install.sh'), 'utf8');
const answersUpFront = /^wizard_answers_up_front\(\) \{\n[\s\S]*?\n\}\n/m.exec(install)![0];

function answers(args: string[], env: Record<string, string> = {}): boolean {
	const result = spawnSync(
		'bash',
		[
			'-c',
			`set -euo pipefail\n${answersUpFront}\nif wizard_answers_up_front "$@"; then echo yes; else echo no; fi`,
			'install.sh',
			...args,
		],
		{
			encoding: 'utf8',
			env: {
				PATH: process.env['PATH'] ?? '',
				OWLAT_ASSUME_YES: '0',
				OWLAT_CONFIG_FILE: '',
				...env,
			},
		}
	);
	expect(result.stderr).toBe('');
	expect(result.status).toBe(0);
	return result.stdout.trim() === 'yes';
}

describe('install.sh wizard_answers_up_front', () => {
	it('needs no terminal for --assume-yes or a config file', () => {
		expect(answers(['--assume-yes'])).toBe(true);
		expect(answers(['-y'])).toBe(true);
		expect(answers(['--config=/root/answers.json'])).toBe(true);
		expect(answers(['--config', '/root/answers.json'])).toBe(true);
		expect(answers([], { OWLAT_ASSUME_YES: '1' })).toBe(true);
		expect(answers([], { OWLAT_CONFIG_FILE: '/root/answers.json' })).toBe(true);
	});

	it('does not take an empty config path for a config file', () => {
		expect(answers(['--config='])).toBe(false);
		expect(answers(['--config', ''])).toBe(false);
		expect(answers(['--config'])).toBe(false);
		// The last path wins, as in scripts/owlat.
		expect(answers(['--config='], { OWLAT_CONFIG_FILE: '/root/answers.json' })).toBe(false);
		expect(answers(['--config=/root/answers.json', '--config='])).toBe(false);
		expect(answers(['--config=', '--config=/root/answers.json'])).toBe(true);
	});

	it('needs a terminal for a run that asks', () => {
		expect(answers([])).toBe(false);
		expect(answers(['--terminal'])).toBe(false);
	});
});
