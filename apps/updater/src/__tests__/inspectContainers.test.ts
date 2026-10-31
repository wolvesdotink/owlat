/**
 * `inspectContainers` reads `docker container inspect` one JSON line per
 * container. A line that is JSON but not a container object is an error the
 * snapshot reports, never a TypeError out of the rollout.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { commandMock } = vi.hoisted(() => ({ commandMock: vi.fn() }));
vi.mock('node:child_process', async () => {
	const { spawnFrom } = await import('./fakeSpawn.js');
	return { spawn: spawnFrom(commandMock) };
});

process.env['OWLAT_DIR'] = mkdtempSync(join(tmpdir(), 'owlat-inspect-test-'));
const { inspectContainers } = await import('../snapshot.js');

const MOUNT = {
	Type: 'volume',
	Name: 'owlat_convex',
	Source: '/var/lib/docker/volumes/x',
	Destination: '/data',
	RW: true,
};
const CONTAINER = { Id: 'abc123', Running: true, Service: 'convex', Mounts: [MOUNT] };

function inspected(stdout: string) {
	commandMock.mockReset();
	commandMock.mockImplementation(() => stdout);
	return inspectContainers(['abc123']);
}

describe('inspectContainers', () => {
	it('reads each container line', async () => {
		expect(await inspected(`${JSON.stringify(CONTAINER)}\n`)).toEqual([
			{
				id: 'abc123',
				running: true,
				service: 'convex',
				mounts: [
					{
						type: 'volume',
						name: 'owlat_convex',
						source: MOUNT.Source,
						destination: '/data',
						rw: true,
					},
				],
			},
		]);
	});

	it.each([
		['null', 'null'],
		['a number', '42'],
		['a list', JSON.stringify([CONTAINER])],
		['a container without an id', JSON.stringify({ ...CONTAINER, Id: 7 })],
		['a container without mounts', JSON.stringify({ ...CONTAINER, Mounts: null })],
	])('answers an error for a line holding %s', async (_name, line) => {
		expect(await inspected(`${line}\n`)).toEqual({
			error: 'docker inspect answered a container without an id or mounts',
		});
	});
});
