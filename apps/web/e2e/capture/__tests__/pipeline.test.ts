// @vitest-environment node
/**
 * One capture run end to end, with the browser and the filesystem faked: a
 * run that fails at any point writes nothing, refusals happen before the
 * browser starts, and the second label of a pair reuses the first one's
 * recorded presentation.
 */
import { describe, expect, it, vi } from 'vitest';
import {
	CaptureUsageError,
	MANIFEST_FILE,
	type CaptureManifest,
	type CaptureRequest,
} from '../options';
import { runCapture, type CaptureIO, type Shooter } from '../pipeline';

const OUT = '/captures/pair';
const KNOWN = ['dashboard', 'postbox', 'contacts'];
const NOW = new Date('2026-10-24T12:00:00.000Z');

function captureRequest(overrides: Partial<CaptureRequest> = {}): CaptureRequest {
	return {
		label: 'before',
		surfaces: ['postbox', 'dashboard'],
		paths: [],
		out: OUT,
		url: undefined,
		theme: undefined,
		viewport: undefined,
		fullPage: false,
		force: false,
		list: false,
		help: false,
		...overrides,
	};
}

/** An in-memory directory; `writeAll` is the only way anything lands in it. */
function memoryIO(initial: Record<string, string | Uint8Array> = {}) {
	const files = new Map<string, string | Uint8Array>(Object.entries(initial));
	const writeAll = vi.fn<CaptureIO['writeAll']>((_dir, written) => {
		for (const { file, data } of written) files.set(file, data);
	});
	const io: CaptureIO = {
		exists: (file) => files.has(file),
		readText: (file) => String(files.get(file)),
		writeAll,
		now: () => NOW,
	};
	return { io, files, writeAll };
}

function png(name: string): Uint8Array {
	return new TextEncoder().encode(`png:${name}`);
}

const shootNames: Shooter = async (shots) => shots.map((shot) => png(shot.name));

describe('runCapture', () => {
	it('writes the manifest and every PNG once all shots succeeded', async () => {
		const { io, files, writeAll } = memoryIO();

		const result = await runCapture(captureRequest(), OUT, KNOWN, shootNames, io);

		expect(result.files).toEqual([`${OUT}/before-dashboard.png`, `${OUT}/before-postbox.png`]);
		expect(writeAll).toHaveBeenCalledOnce();
		expect(files.get(`${OUT}/before-postbox.png`)).toEqual(png('postbox'));
		expect(JSON.parse(String(files.get(`${OUT}/${MANIFEST_FILE}`)))).toEqual({
			version: 1,
			clock: NOW.toISOString(),
			theme: 'light',
			viewport: { width: 1440, height: 900 },
			fullPage: false,
		});
	});

	it('writes nothing when a shot fails partway', async () => {
		const { io, files, writeAll } = memoryIO();
		const shoot: Shooter = async () => {
			throw new Error('postbox: the app sent the browser back to sign-in (/auth/login).');
		};

		await expect(runCapture(captureRequest(), OUT, KNOWN, shoot, io)).rejects.toThrow(/sign-in/);
		expect(writeAll).not.toHaveBeenCalled();
		expect(files.size).toBe(0);
	});

	it('writes nothing when the browser returns fewer images than shots', async () => {
		const { io, writeAll } = memoryIO();
		const shoot: Shooter = async () => [png('dashboard')];

		await expect(runCapture(captureRequest(), OUT, KNOWN, shoot, io)).rejects.toThrow(
			/Expected 2 captures, got 1/
		);
		expect(writeAll).not.toHaveBeenCalled();
	});

	it('refuses to replace the "before" evidence without starting the browser', async () => {
		const { io, files, writeAll } = memoryIO({ [`${OUT}/before-postbox.png`]: png('original') });
		const shoot = vi.fn<Shooter>(shootNames);

		await expect(runCapture(captureRequest(), OUT, KNOWN, shoot, io)).rejects.toThrow(
			CaptureUsageError
		);
		expect(shoot).not.toHaveBeenCalled();
		expect(writeAll).not.toHaveBeenCalled();
		expect(files.get(`${OUT}/before-postbox.png`)).toEqual(png('original'));
	});

	it('captures "after" with the recorded settings and leaves "before" untouched', async () => {
		const recorded: CaptureManifest = {
			version: 1,
			clock: '2026-10-23T08:00:00.000Z',
			theme: 'dark',
			viewport: { width: 1280, height: 800 },
			fullPage: true,
		};
		const manifestText = JSON.stringify(recorded);
		const { io, files } = memoryIO({
			[`${OUT}/${MANIFEST_FILE}`]: manifestText,
			[`${OUT}/before-dashboard.png`]: png('before'),
		});
		const shoot = vi.fn<Shooter>(shootNames);

		const result = await runCapture(
			captureRequest({ label: 'after', surfaces: ['dashboard'] }),
			OUT,
			KNOWN,
			shoot,
			io
		);

		expect(shoot).toHaveBeenCalledWith(
			[{ name: 'dashboard', file: `${OUT}/after-dashboard.png` }],
			recorded
		);
		expect(result.manifestCreated).toBe(false);
		expect(files.get(`${OUT}/${MANIFEST_FILE}`)).toBe(manifestText);
		expect(files.get(`${OUT}/before-dashboard.png`)).toEqual(png('before'));
		expect(files.get(`${OUT}/after-dashboard.png`)).toEqual(png('dashboard'));
	});

	it('refuses a run whose flags disagree with the recorded pair before the browser starts', async () => {
		const recorded: CaptureManifest = {
			version: 1,
			clock: '2026-10-23T08:00:00.000Z',
			theme: 'light',
			viewport: { width: 1440, height: 900 },
			fullPage: false,
		};
		const { io } = memoryIO({ [`${OUT}/${MANIFEST_FILE}`]: JSON.stringify(recorded) });
		const shoot = vi.fn<Shooter>(shootNames);

		await expect(
			runCapture(captureRequest({ label: 'after', theme: 'dark' }), OUT, KNOWN, shoot, io)
		).rejects.toThrow(/--theme dark/);
		expect(shoot).not.toHaveBeenCalled();
	});
});
