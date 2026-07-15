import type {
	JsonValue,
	PluginCapability,
	PluginId,
	PluginStorageListOptions,
	PluginStorageListResult,
	PluginStorageService,
} from '@owlat/plugin-kit';
import { parsePluginId } from '@owlat/plugin-kit';
import type { MutationCtx } from '../_generated/server';
import { requireAuthenticatedBundledPlugin } from './authorization';
import { recordHostedPluginAudit, type HostedPluginOperation } from './audit';
import {
	decryptPluginStorageCursor,
	encryptPluginStorageCursor,
	MAX_PLUGIN_STORAGE_CURSOR_CHARS,
	PluginStorageCursorError,
} from './storageCursor';
import {
	decodePluginStorageValue,
	encodePluginStorageValue,
	PLUGIN_STORAGE_LIMITS,
	pluginStorageEntryBytes,
	validatePluginStorageKey,
} from './storageJson';

export const PLUGIN_STORAGE_READ_CAPABILITY = 'plugin-storage:read' as PluginCapability;
export const PLUGIN_STORAGE_WRITE_CAPABILITY = 'plugin-storage:write' as PluginCapability;

type StorageAuthorization = (capability: PluginCapability) => Promise<void>;

interface PluginStorageScope {
	readonly organizationId: string;
	readonly pluginId: PluginId;
	readonly userId: string;
}

export type PluginStorageErrorCode =
	| 'access_denied'
	| 'invalid_input'
	| 'quota_exceeded'
	| 'storage_unavailable';

/** Redacted error contract: no tenant, plugin, key, value, or cursor data. */
export class PluginStorageError extends Error {
	readonly code: PluginStorageErrorCode;

	constructor(code: PluginStorageErrorCode) {
		super(pluginStorageErrorMessage(code));
		this.name = 'PluginStorageError';
		this.code = code;
	}
}

/**
 * Bind storage to the authenticated active organization and one statically
 * registered plugin. Scope is absent from every returned method. The service
 * is created and consumed within one Convex mutation invocation, whose auth
 * identity is immutable; it cannot outlive or be serialized beyond that
 * transaction. Plugin enablement and grants are still reloaded on every call.
 */
export async function bindAuthenticatedBundledPluginStorage(
	ctx: MutationCtx,
	pluginIdInput: unknown
): Promise<PluginStorageService> {
	let pluginId: PluginId;
	try {
		pluginId = parsePluginId(pluginIdInput);
	} catch {
		throw new PluginStorageError('access_denied');
	}
	const authorized = await requireAuthenticatedBundledPlugin(ctx, pluginId).catch(() => null);
	if (!authorized) {
		throw new PluginStorageError('access_denied');
	}
	return createScopedPluginStorageService(
		ctx,
		Object.freeze({
			organizationId: authorized.organizationId,
			pluginId,
			userId: authorized.userId,
		}),
		(capability) => authorizeBundledStorage(ctx, pluginId, capability)
	);
}

/** Internal host primitive; callers must authenticate before constructing scope. */
// Deliberately private: PP-21 may add a connected-app authenticator that calls
// this core, but no production caller can manufacture an organization/plugin
// scope without first passing an authenticator owned by this module.
function createScopedPluginStorageService(
	ctx: MutationCtx,
	scope: PluginStorageScope,
	authorize: StorageAuthorization
): PluginStorageService {
	const organizationId = scope.organizationId;
	const pluginId = parsePluginId(scope.pluginId);
	if (organizationId.length === 0) throw new PluginStorageError('access_denied');

	return Object.freeze({
		async get(keyInput: string): Promise<JsonValue | undefined> {
			await requireStorageAuthorization(authorize, PLUGIN_STORAGE_READ_CAPABILITY);
			const key = readKey(keyInput);
			const entry = await findEntry(ctx, organizationId, pluginId, key);
			if (!entry) {
				await auditStorageOperation(ctx, scope, 'storage.get');
				return undefined;
			}
			try {
				const value = decodePluginStorageValue(entry.valueJson, entry.valueJsonVersion);
				await auditStorageOperation(ctx, scope, 'storage.get');
				return value;
			} catch {
				throw new PluginStorageError('storage_unavailable');
			}
		},

		async set(keyInput: string, value: JsonValue): Promise<void> {
			await requireStorageAuthorization(authorize, PLUGIN_STORAGE_WRITE_CAPABILITY);
			const key = readKey(keyInput);
			let encoded;
			try {
				encoded = encodePluginStorageValue(value);
			} catch {
				throw new PluginStorageError('invalid_input');
			}
			const storedBytes = pluginStorageEntryBytes(key, encoded.bytes);
			const [entry, usage] = await Promise.all([
				findEntry(ctx, organizationId, pluginId, key),
				findUsage(ctx, organizationId, pluginId),
			]);
			assertUsageConsistent(entry?.storedBytes, usage);
			const entryCount = (usage?.entryCount ?? 0) + (entry ? 0 : 1);
			const totalStoredBytes =
				(usage?.totalStoredBytes ?? 0) + storedBytes - (entry?.storedBytes ?? 0);
			if (
				!Number.isSafeInteger(entryCount) ||
				!Number.isSafeInteger(totalStoredBytes) ||
				entryCount < 1 ||
				totalStoredBytes < storedBytes ||
				entryCount > PLUGIN_STORAGE_LIMITS.maxEntries ||
				totalStoredBytes > PLUGIN_STORAGE_LIMITS.maxTotalBytes
			) {
				throw new PluginStorageError('quota_exceeded');
			}

			const now = Date.now();
			const storedValue = {
				valueJson: encoded.json,
				valueJsonVersion: encoded.version,
				storedBytes,
				updatedAt: now,
			};
			if (entry) await ctx.db.patch(entry._id, storedValue);
			else {
				await ctx.db.insert('pluginStorageEntries', {
					organizationId,
					pluginId,
					key,
					...storedValue,
					createdAt: now,
				});
			}
			if (usage) {
				await ctx.db.patch(usage._id, { entryCount, totalStoredBytes, updatedAt: now });
			} else {
				await ctx.db.insert('pluginStorageUsage', {
					organizationId,
					pluginId,
					entryCount,
					totalStoredBytes,
					updatedAt: now,
				});
			}
			await auditStorageOperation(ctx, scope, 'storage.set');
		},

		async delete(keyInput: string): Promise<void> {
			await requireStorageAuthorization(authorize, PLUGIN_STORAGE_WRITE_CAPABILITY);
			const key = readKey(keyInput);
			const entry = await findEntry(ctx, organizationId, pluginId, key);
			if (!entry) {
				await auditStorageOperation(ctx, scope, 'storage.delete');
				return;
			}
			const usage = await findUsage(ctx, organizationId, pluginId);
			assertUsageConsistent(entry.storedBytes, usage);
			const entryCount = usage!.entryCount - 1;
			const totalStoredBytes = usage!.totalStoredBytes - entry.storedBytes;
			if (entryCount < 0 || totalStoredBytes < 0) {
				throw new PluginStorageError('storage_unavailable');
			}
			await ctx.db.delete(entry._id);
			if (entryCount === 0) await ctx.db.delete(usage!._id);
			else {
				await ctx.db.patch(usage!._id, {
					entryCount,
					totalStoredBytes,
					updatedAt: Date.now(),
				});
			}
			await auditStorageOperation(ctx, scope, 'storage.delete');
		},

		async list(options?: PluginStorageListOptions): Promise<PluginStorageListResult> {
			await requireStorageAuthorization(authorize, PLUGIN_STORAGE_READ_CAPABILITY);
			const request = readListRequest(options);
			const nativeCursor = await unwrapCursor(scope, request);
			const upperBound = prefixUpperBound(request.prefix);
			const page = await ctx.db
				.query('pluginStorageEntries')
				.withIndex('by_organization_id_and_plugin_id_and_key', (index) => {
					const scopeRange = index.eq('organizationId', organizationId).eq('pluginId', pluginId);
					if (request.prefix.length === 0) return scopeRange;
					const prefixRange = scopeRange.gte('key', request.prefix);
					return upperBound === undefined ? prefixRange : prefixRange.lt('key', upperBound);
				})
				.paginate({ cursor: nativeCursor, numItems: request.limit })
				.catch(() => {
					throw new PluginStorageError('storage_unavailable');
				});
			const cursor = page.isDone
				? undefined
				: await wrapCursor(scope, request, page.continueCursor);
			const result = Object.freeze({
				keys: Object.freeze(page.page.map((entry) => entry.key)),
				...(cursor === undefined ? {} : { cursor }),
			});
			await auditStorageOperation(ctx, scope, 'storage.list');
			return result;
		},
	});
}

async function auditStorageOperation(
	ctx: MutationCtx,
	scope: PluginStorageScope,
	operation: Extract<HostedPluginOperation, `storage.${string}`>
): Promise<void> {
	try {
		await recordHostedPluginAudit(
			ctx,
			{ organizationId: scope.organizationId, pluginId: scope.pluginId, userId: scope.userId },
			operation,
			'completed'
		);
	} catch {
		throw new PluginStorageError('storage_unavailable');
	}
}

async function authorizeBundledStorage(
	ctx: MutationCtx,
	pluginId: PluginId,
	capability?: PluginCapability
): Promise<void> {
	try {
		await requireAuthenticatedBundledPlugin(ctx, pluginId, capability);
	} catch {
		throw new PluginStorageError('access_denied');
	}
}

async function requireStorageAuthorization(
	authorize: StorageAuthorization,
	capability: PluginCapability
): Promise<void> {
	try {
		await authorize(capability);
	} catch {
		throw new PluginStorageError('access_denied');
	}
}

function readKey(value: unknown): string {
	try {
		return validatePluginStorageKey(value);
	} catch {
		throw new PluginStorageError('invalid_input');
	}
}

async function findEntry(
	ctx: MutationCtx,
	organizationId: string,
	pluginId: PluginId,
	key: string
) {
	return ctx.db
		.query('pluginStorageEntries')
		.withIndex('by_organization_id_and_plugin_id_and_key', (index) =>
			index.eq('organizationId', organizationId).eq('pluginId', pluginId).eq('key', key)
		)
		.unique();
}

async function findUsage(ctx: MutationCtx, organizationId: string, pluginId: PluginId) {
	return ctx.db
		.query('pluginStorageUsage')
		.withIndex('by_organization_id_and_plugin_id', (index) =>
			index.eq('organizationId', organizationId).eq('pluginId', pluginId)
		)
		.unique();
}

function assertUsageConsistent(
	existingEntryBytes: number | undefined,
	usage: { readonly entryCount: number; readonly totalStoredBytes: number } | null
): void {
	const existingEntryMatchesAggregate =
		existingEntryBytes === undefined ||
		(usage !== null &&
			(usage.entryCount === 1
				? usage.totalStoredBytes === existingEntryBytes
				: usage.totalStoredBytes > existingEntryBytes));
	if (
		(existingEntryBytes !== undefined &&
			(!Number.isSafeInteger(existingEntryBytes) ||
				existingEntryBytes < 1 ||
				!existingEntryMatchesAggregate)) ||
		(usage !== null &&
			(!Number.isSafeInteger(usage.entryCount) ||
				!Number.isSafeInteger(usage.totalStoredBytes) ||
				usage.entryCount < 1 ||
				usage.totalStoredBytes < 1))
	) {
		throw new PluginStorageError('storage_unavailable');
	}
}

interface ListRequest {
	readonly prefix: string;
	readonly limit: number;
	readonly cursor?: string;
}

function readListRequest(options: PluginStorageListOptions | undefined): ListRequest {
	try {
		if (options === undefined) return Object.freeze({ prefix: '', limit: 50 });
		if (options === null || typeof options !== 'object' || Array.isArray(options)) {
			throw new Error();
		}
		const keys = Reflect.ownKeys(options);
		if (
			keys.some((key) => typeof key !== 'string' || !['prefix', 'limit', 'cursor'].includes(key))
		) {
			throw new Error();
		}
		const prefix = readDataProperty(options, 'prefix') ?? '';
		const limit = readDataProperty(options, 'limit') ?? 50;
		const cursor = readDataProperty(options, 'cursor');
		if (typeof prefix !== 'string' || (prefix !== '' && readKey(prefix) !== prefix))
			throw new Error();
		if (
			typeof limit !== 'number' ||
			!Number.isInteger(limit) ||
			limit < 1 ||
			limit > PLUGIN_STORAGE_LIMITS.maxListPageSize
		) {
			throw new Error();
		}
		if (
			cursor !== undefined &&
			(typeof cursor !== 'string' || cursor.length > MAX_PLUGIN_STORAGE_CURSOR_CHARS)
		) {
			throw new Error();
		}
		return Object.freeze({ prefix, limit, ...(cursor === undefined ? {} : { cursor }) });
	} catch {
		throw new PluginStorageError('invalid_input');
	}
}

function readDataProperty(object: object, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(object, key);
	if (!descriptor) return undefined;
	if (!('value' in descriptor) || !descriptor.enumerable) throw new Error();
	return descriptor.value;
}

function prefixUpperBound(prefix: string): string | undefined {
	if (prefix.length === 0) return undefined;
	const points = Array.from(prefix, (character) => character.codePointAt(0)!);
	for (let index = points.length - 1; index >= 0; index -= 1) {
		if (points[index]! >= 0x10ffff) continue;
		points[index] = points[index]! + 1;
		return String.fromCodePoint(...points.slice(0, index + 1));
	}
	return undefined;
}

async function wrapCursor(
	scope: PluginStorageScope,
	request: ListRequest,
	nativeCursor: string
): Promise<string> {
	try {
		return await encryptPluginStorageCursor(scope, request, nativeCursor);
	} catch {
		throw new PluginStorageError('storage_unavailable');
	}
}

async function unwrapCursor(
	scope: PluginStorageScope,
	request: ListRequest
): Promise<string | null> {
	if (request.cursor === undefined) return null;
	try {
		return await decryptPluginStorageCursor(scope, request, request.cursor);
	} catch (error) {
		throw new PluginStorageError(
			error instanceof PluginStorageCursorError && error.failure === 'invalid_token'
				? 'invalid_input'
				: 'storage_unavailable'
		);
	}
}

function pluginStorageErrorMessage(code: PluginStorageErrorCode): string {
	switch (code) {
		case 'access_denied':
			return 'Plugin storage access denied';
		case 'invalid_input':
			return 'Invalid plugin storage request';
		case 'quota_exceeded':
			return 'Plugin storage quota exceeded';
		case 'storage_unavailable':
			return 'Plugin storage unavailable';
	}
}
