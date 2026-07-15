import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	decryptPluginStorageCursor,
	encryptPluginStorageCursor,
	PluginStorageCursorError,
} from '../storageCursor';

const scope = { organizationId: 'sensitive-tenant', pluginId: 'sensitive-plugin' };
const request = { prefix: 'secret-prefix:', limit: 25 };
const nativeCursor = JSON.stringify({
	organizationId: scope.organizationId,
	pluginId: scope.pluginId,
	key: 'secret-prefix:customer-key',
	timestamp: 1_721_234_567_890,
	documentId: 'secret-pluginStorageEntries-document-id',
});

beforeEach(() => vi.stubEnv('INSTANCE_SECRET', 'plugin-storage-cursor-test-secret'));
afterEach(() => vi.unstubAllEnvs());

describe('plugin storage cursor encryption', () => {
	it('round-trips while exposing only randomized IV and authenticated ciphertext', async () => {
		const first = await encryptPluginStorageCursor(scope, request, nativeCursor);
		const second = await encryptPluginStorageCursor(scope, request, nativeCursor);

		expect(first).not.toBe(second);
		expect(await decryptPluginStorageCursor(scope, request, first)).toBe(nativeCursor);
		const publicSegments = first.split('.').slice(2).map(decodeBase64UrlForInspection).join('\n');
		for (const secret of [
			nativeCursor,
			scope.organizationId,
			scope.pluginId,
			'secret-prefix:customer-key',
			'1721234567890',
			'secret-pluginStorageEntries-document-id',
		]) {
			expect(publicSegments).not.toContain(secret);
		}
	});

	it.each([
		['tenant', { ...scope, organizationId: 'other-tenant' }, request],
		['plugin', { ...scope, pluginId: 'other-plugin' }, request],
		['prefix', scope, { ...request, prefix: 'other-prefix:' }],
		['page shape', scope, { ...request, limit: request.limit + 1 }],
	] as const)('authenticates the %s binding', async (_label, otherScope, otherRequest) => {
		const token = await encryptPluginStorageCursor(scope, request, nativeCursor);
		await expect(decryptPluginStorageCursor(otherScope, otherRequest, token)).rejects.toMatchObject(
			{
				failure: 'invalid_token',
			}
		);
	});

	it('rejects tamper and malformed encodings through authenticated decryption', async () => {
		const token = await encryptPluginStorageCursor(scope, request, nativeCursor);
		const parts = token.split('.');
		parts[3] = replaceMiddleBase64UrlCharacter(parts[3]!);
		for (const candidate of [
			parts.join('.'),
			'not-a-cursor',
			`${token}=`,
			token.replace('.1.', '.2.'),
		]) {
			await expect(decryptPluginStorageCursor(scope, request, candidate)).rejects.toMatchObject({
				failure: 'invalid_token',
			});
		}
	});

	it('rejects a structurally valid token encrypted under another server secret', async () => {
		const token = await encryptPluginStorageCursor(scope, request, nativeCursor);
		vi.stubEnv('INSTANCE_SECRET', 'different-plugin-storage-cursor-secret');

		await expect(decryptPluginStorageCursor(scope, request, token)).rejects.toMatchObject({
			failure: 'invalid_token',
		});
	});

	it('distinguishes missing server key material from invalid client tokens', async () => {
		vi.stubEnv('INSTANCE_SECRET', '');
		const error = await encryptPluginStorageCursor(scope, request, nativeCursor).catch(
			(cause) => cause
		);
		expect(error).toBeInstanceOf(PluginStorageCursorError);
		expect(error).toMatchObject({ failure: 'crypto_unavailable' });
		expect((error as Error).message).not.toContain('sensitive');
		expect((error as Error).message).not.toContain('secret-prefix');
	});
});

function decodeBase64UrlForInspection(value: string): string {
	const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
	return atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
}

function replaceMiddleBase64UrlCharacter(value: string): string {
	const index = Math.floor(value.length / 2);
	const replacement = value[index] === 'A' ? 'B' : 'A';
	return `${value.slice(0, index)}${replacement}${value.slice(index + 1)}`;
}
