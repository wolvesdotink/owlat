import type { PluginCapabilityGrant } from '@owlat/plugin-kit';
import { describe, expect, it } from 'vitest';
import { createPluginPermissionService } from '../index';

function createPermissions(grants: readonly PluginCapabilityGrant[]) {
	return createPluginPermissionService({
		pluginId: 'policy-pack',
		declaredCapabilities: ['mail:read', 'send:gate'],
		grants,
	});
}

describe('plugin capability enforcement', () => {
	it('requires an explicit true grant for a declared capability', () => {
		const permissions = createPermissions([
			{ capability: 'mail:read', granted: true },
			{ capability: 'send:gate', granted: false },
		]);

		expect(permissions.has('mail:read')).toBe(true);
		expect(permissions.has('send:gate')).toBe(false);
		expect(() => permissions.require('mail:read')).not.toThrow();
		expect(() => permissions.require('send:gate')).toThrowError(
			expect.objectContaining({ code: 'capability_not_granted' })
		);
	});

	it('fails closed when the operator omitted a grant', () => {
		const permissions = createPermissions([]);

		expect(permissions.has('mail:read')).toBe(false);
		expect(() => permissions.require('mail:read')).toThrowError(
			expect.objectContaining({ code: 'capability_not_granted' })
		);
	});

	it('distinguishes an undeclared capability from a denied request', () => {
		const permissions = createPermissions([]);

		expect(permissions.has('contacts:write')).toBe(false);
		expect(() => permissions.require('contacts:write')).toThrowError(
			expect.objectContaining({ code: 'capability_not_declared' })
		);
	});

	it('rejects attempts to grant authority absent from the manifest', () => {
		expect(() => createPermissions([{ capability: 'contacts:write', granted: true }])).toThrowError(
			expect.objectContaining({ code: 'invalid_capability_grant' })
		);
	});

	it('rejects duplicate and malformed grant configuration deterministically', () => {
		expect(() =>
			createPermissions([
				{ capability: 'mail:read', granted: false },
				{ capability: 'mail:read', granted: true },
			])
		).toThrowError(expect.objectContaining({ code: 'invalid_capability_grant' }));

		expect(() =>
			createPermissions([
				{ capability: 'mail:read', granted: 'yes' } as unknown as PluginCapabilityGrant,
			])
		).toThrowError(expect.objectContaining({ code: 'invalid_capability_grant' }));
	});

	it('rejects grant accessors without executing them', () => {
		let reads = 0;
		const grant = { granted: true };
		Object.defineProperty(grant, 'capability', {
			enumerable: true,
			get() {
				reads += 1;
				return 'mail:read';
			},
		});

		expect(() => createPermissions([grant as unknown as PluginCapabilityGrant])).toThrowError(
			expect.objectContaining({ code: 'invalid_capability_grant' })
		);
		expect(reads).toBe(0);
	});
});
