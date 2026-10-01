import { chmod, lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeOwnerOnlyFile } from '../ownerOnlyFile';

// `open` is wrapped so a case can fake a handle whose chmod fails or does
// nothing; every other case gets the real one.
vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof fsPromises>();
	return { ...actual, open: vi.fn(actual.open) };
});

const realOpen = (await vi.importActual<typeof fsPromises>('node:fs/promises')).open;

/** The next `open` returns a real handle whose `chmod` is `chmodImpl`. */
function nextHandleChmod(chmodImpl: () => Promise<void>): void {
	vi.mocked(fsPromises.open).mockImplementationOnce(async (...args) => {
		const handle = await realOpen(...args);
		Object.defineProperty(handle, 'chmod', { value: chmodImpl });
		return handle;
	});
}

async function modeOf(path: string): Promise<number> {
	return (await stat(path)).mode & 0o777;
}

describe.skipIf(process.platform === 'win32')('writeOwnerOnlyFile', () => {
	let dir: string;
	let path: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'owlat-owner-only-'));
		path = join(dir, '.env');
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it('creates a missing file as 0600', async () => {
		await writeOwnerOnlyFile(path, 'INSTANCE_SECRET=abc\n');
		expect(await modeOf(path)).toBe(0o600);
		expect(await readFile(path, 'utf-8')).toBe('INSTANCE_SECRET=abc\n');
	});

	it.each([
		['0644', 0o644],
		['0666', 0o666],
		['0640', 0o640],
		['0604', 0o604],
	])('tightens an existing %s file to 0600 and replaces its contents', async (_label, initial) => {
		await writeFile(path, 'OLD=a much longer line than the new contents\n');
		await chmod(path, initial);

		await writeOwnerOnlyFile(path, 'NEW=1\n');

		expect(await modeOf(path)).toBe(0o600);
		expect(await readFile(path, 'utf-8')).toBe('NEW=1\n');
	});

	it('rewrites the file in place, so a bind-mounted file keeps its inode', async () => {
		await writeFile(path, 'OLD=1\n');
		await chmod(path, 0o644);
		const before = await stat(path);

		await writeOwnerOnlyFile(path, 'NEW=1\n');

		const after = await stat(path);
		expect(after.ino).toBe(before.ino);
		expect(after.uid).toBe(before.uid);
		expect(after.gid).toBe(before.gid);
	});

	it('writes through a symlinked file and secures its target', async () => {
		const target = join(dir, 'env.real');
		await writeFile(target, 'OLD=1\n');
		await chmod(target, 0o644);
		await symlink(target, path);

		await writeOwnerOnlyFile(path, 'NEW=1\n');

		expect((await lstat(path)).isSymbolicLink()).toBe(true);
		expect(await modeOf(target)).toBe(0o600);
		expect(await readFile(target, 'utf-8')).toBe('NEW=1\n');
	});

	it('refuses to write, leaving the file untouched, when chmod fails', async () => {
		await writeFile(path, 'OLD=1\n');
		await chmod(path, 0o644);
		nextHandleChmod(async () => {
			throw Object.assign(new Error('EPERM: operation not permitted, fchmod'), {
				code: 'EPERM',
			});
		});

		await expect(writeOwnerOnlyFile(path, 'INSTANCE_SECRET=abc\n')).rejects.toThrow(
			/could not make it owner-only.*EPERM/
		);
		expect(await readFile(path, 'utf-8')).toBe('OLD=1\n');
		expect(await modeOf(path)).toBe(0o644);
	});

	it('refuses to write, leaving the file untouched, when the filesystem ignores chmod', async () => {
		await writeFile(path, 'OLD=1\n');
		await chmod(path, 0o666);
		nextHandleChmod(async () => undefined);

		await expect(writeOwnerOnlyFile(path, 'INSTANCE_SECRET=abc\n')).rejects.toThrow(
			/mode is still 666 after chmod 600/
		);
		expect(await readFile(path, 'utf-8')).toBe('OLD=1\n');
	});
});
