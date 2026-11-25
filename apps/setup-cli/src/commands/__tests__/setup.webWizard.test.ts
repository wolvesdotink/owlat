import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `owlat setup --web` names the URL the web wizard opens on. The web container
 * publishes `${WEB_PORT:-3000}`, so that URL follows a port the install's
 * `.env` moved.
 */

vi.mock('@clack/prompts', () => ({
	intro: vi.fn(),
	outro: vi.fn(),
	log: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warn: vi.fn() },
	isCancel: vi.fn(() => false),
	// The re-run question an existing `.env` asks first.
	select: vi.fn(async () => 'full'),
}));

const spawned = vi.hoisted(() => [] as string[][]);
vi.mock('node:child_process', () => ({
	spawn: vi.fn((cmd: string, args: string[]) => {
		spawned.push([cmd, ...args]);
		return { unref: () => {} };
	}),
}));

import * as clack from '@clack/prompts';
import { runSetup } from '../setup';

let dir = '';

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'owlat-setup-web-'));
	spawned.length = 0;
	vi.stubEnv('DISPLAY', ':0');
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.mocked(clack.log.info).mockClear();
	rmSync(dir, { recursive: true, force: true });
});

const run = () =>
	runSetup({
		owlatDir: dir,
		web: true,
		terminal: false,
		assumeYes: false,
		positional: [],
	});

describe('setup --web', () => {
	it('opens the wizard on the web port .env publishes', async () => {
		writeFileSync(
			join(dir, '.env'),
			'FBL_DEDUP_PROTOCOL=owned-v2\nFBL_DEDUP_CUTOVER_ACK=fresh-install\nWEB_PORT=8080\n'
		);
		expect(await run()).toBe(0);
		const said = vi.mocked(clack.log.info).mock.calls.map(([line]) => String(line));
		expect(said[0]).toContain('http://localhost:8080/setup');
		expect(spawned.at(-1)?.at(-1)).toBe('http://localhost:8080/setup');
	});

	it('opens it on port 3000 when .env does not move the port', async () => {
		expect(await run()).toBe(0);
		expect(spawned.at(-1)?.at(-1)).toBe('http://localhost:3000/setup');
	});
});
