import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The entry point routes `support-bundle` to its command and lists it in the
 * help text, which is what `scripts/owlat` probes (`setup_image_has_command`)
 * before it runs the command in a pinned setup image.
 */

const ENTRY = fileURLToPath(new URL('../index.ts', import.meta.url));

function cli(...args: string[]) {
	return spawnSync('bun', [ENTRY, ...args], { encoding: 'utf8' });
}

describe('owlat-setup support-bundle dispatch', () => {
	it('is listed in --help', () => {
		const result = cli('--help');
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('support-bundle [--lines N] [--output FILE|-]');
	});

	it('reaches the command, which validates its options before touching Docker', () => {
		const result = cli('support-bundle', '--lines', '0', '--output', '-');
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('--lines must be between 1 and 5000');
		expect(result.stdout).toBe('');
	});
});
