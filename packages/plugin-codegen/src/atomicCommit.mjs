import { randomBytes } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { lstat, open, rename, rm, stat } from 'node:fs/promises';
import { basename } from 'node:path';

const [expectedDevice, expectedInode, targetName] = process.argv.slice(2);
if (
	!expectedDevice ||
	!expectedInode ||
	!targetName ||
	basename(targetName) !== targetName ||
	targetName === '.' ||
	targetName === '..'
) {
	throw new Error('Invalid stable-directory commit arguments');
}

const expectedParent = { device: Number(expectedDevice), inode: Number(expectedInode) };
const temporaryName = `.${targetName}.${randomBytes(16).toString('hex')}.tmp`;
let temporaryFile;
let temporaryIdentity;
let committed = false;

try {
	await assertCurrentDirectoryIdentity();
	temporaryFile = await open(
		temporaryName,
		constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
		0o600
	);
	temporaryIdentity = await temporaryFile.stat();
	if (!temporaryIdentity.isFile()) throw new Error('Temporary output is not a regular file');

	for await (const chunk of process.stdin) await temporaryFile.write(chunk);
	await temporaryFile.chmod(0o644);
	await temporaryFile.sync();
	await temporaryFile.close();
	temporaryFile = undefined;
	await assertTemporaryIdentity();

	process.stdout.write('READY\n');
	await waitForCommitSignal();
	await assertCurrentDirectoryIdentity();
	await rejectUnsafeTarget();
	await rename(temporaryName, targetName);
	committed = true;
	process.stdout.write('DONE\n');
} catch (cause) {
	process.stderr.write(`${cause instanceof Error ? cause.message : 'Atomic commit failed'}\n`);
	process.exitCode = 1;
} finally {
	await temporaryFile?.close();
	if (!committed && temporaryIdentity) await removeOwnedTemporary();
}

async function assertCurrentDirectoryIdentity() {
	const current = await stat('.');
	if (
		!current.isDirectory() ||
		current.dev !== expectedParent.device ||
		current.ino !== expectedParent.inode
	) {
		throw new Error('Generated parent directory changed before commit worker initialization');
	}
}

async function assertTemporaryIdentity() {
	const current = await lstat(temporaryName);
	if (
		!current.isFile() ||
		current.isSymbolicLink() ||
		current.dev !== temporaryIdentity.dev ||
		current.ino !== temporaryIdentity.ino
	) {
		throw new Error('Temporary output changed identity');
	}
}

async function rejectUnsafeTarget() {
	try {
		const target = await lstat(targetName);
		if (target.isSymbolicLink() || !target.isFile()) {
			throw new Error('Generated target is not a regular file');
		}
	} catch (cause) {
		if (!(cause instanceof Error && 'code' in cause && cause.code === 'ENOENT')) throw cause;
	}
}

async function waitForCommitSignal() {
	const control = createReadStream('', { fd: 3, autoClose: true });
	let signal = '';
	for await (const chunk of control) {
		signal += chunk.toString('utf8');
		if (signal.length > 16) throw new Error('Invalid atomic commit control signal');
	}
	if (signal !== 'COMMIT\n') throw new Error('Atomic commit was cancelled');
}

async function removeOwnedTemporary() {
	try {
		const current = await lstat(temporaryName);
		if (
			current.isFile() &&
			!current.isSymbolicLink() &&
			current.dev === temporaryIdentity.dev &&
			current.ino === temporaryIdentity.ino
		) {
			await rm(temporaryName);
		}
	} catch (cause) {
		if (!(cause instanceof Error && 'code' in cause && cause.code === 'ENOENT')) throw cause;
	}
}
