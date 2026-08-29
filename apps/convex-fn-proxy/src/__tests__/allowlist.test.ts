import { describe, it, expect } from 'vitest';
import {
	ALLOWED_FUNCTION_PATHS,
	extractConvexToken,
	isAllowedEndpoint,
	isAllowedFunctionPath,
	readFunctionPath,
	safeTokenEqual,
} from '../allowlist.js';

describe('function allowlist', () => {
	it('permits exactly the thirteen worker-queue functions across both namespaces', () => {
		expect([...ALLOWED_FUNCTION_PATHS].sort()).toEqual(
			[
				'codeWorkTasks:getNextQueued',
				'codeWorkTasks:claim',
				'codeWorkTasks:updateBranch',
				'codeWorkTasks:markTesting',
				'codeWorkTasks:completeWithPR',
				'codeWorkTasks:markFailed',
				'codeWorkTasks:reclaimStale',
				'plugins/workerTasks:getNextQueued',
				'plugins/workerTasks:claim',
				'plugins/workerTasks:heartbeat',
				'plugins/workerTasks:complete',
				'plugins/workerTasks:fail',
				'plugins/workerTasks:reclaimStale',
			].sort()
		);
		expect(ALLOWED_FUNCTION_PATHS.size).toBe(13);
	});

	it('accepts every allowlisted path', () => {
		for (const path of ALLOWED_FUNCTION_PATHS) {
			expect(isAllowedFunctionPath(path)).toBe(true);
		}
	});

	it('rejects functions outside the allowlist, including sibling mutations', () => {
		for (const path of [
			'codeWorkTasks:create',
			'codeWorkTasks:cancel',
			'codeWorkTasks:list',
			'plugins/workerTasks:enqueue',
			'organizations:deleteAll',
			'auth:signIn',
			'',
		]) {
			expect(isAllowedFunctionPath(path)).toBe(false);
		}
	});

	it('rejects non-string paths', () => {
		expect(isAllowedFunctionPath(undefined)).toBe(false);
		expect(isAllowedFunctionPath(null)).toBe(false);
		expect(isAllowedFunctionPath(42)).toBe(false);
	});
});

describe('endpoint allowlist', () => {
	it('accepts the three query/mutation/action endpoints', () => {
		expect(isAllowedEndpoint('/api/query')).toBe(true);
		expect(isAllowedEndpoint('/api/mutation')).toBe(true);
		expect(isAllowedEndpoint('/api/action')).toBe(true);
	});

	it('refuses every other endpoint', () => {
		for (const p of ['/api/query_ts', '/api/query_at_ts', '/api/function', '/', '/version']) {
			expect(isAllowedEndpoint(p)).toBe(false);
		}
	});
});

describe('extractConvexToken', () => {
	it('returns the token after the Convex scheme prefix', () => {
		expect(extractConvexToken('Convex abc123')).toBe('abc123');
	});

	it('returns null for a missing, empty, or non-Convex header', () => {
		expect(extractConvexToken(undefined)).toBeNull();
		expect(extractConvexToken('Bearer abc123')).toBeNull();
		expect(extractConvexToken('Convex ')).toBeNull();
		expect(extractConvexToken('convex abc')).toBeNull();
	});
});

describe('safeTokenEqual', () => {
	it('is true for equal tokens and false otherwise, tolerating length differences', () => {
		expect(safeTokenEqual('the-secret', 'the-secret')).toBe(true);
		expect(safeTokenEqual('the-secret', 'the-secre')).toBe(false);
		expect(safeTokenEqual('short', 'a-much-longer-token')).toBe(false);
	});
});

describe('readFunctionPath', () => {
	it('extracts a string path from a well-formed body', () => {
		expect(readFunctionPath(JSON.stringify({ path: 'codeWorkTasks:claim', args: [{}] }))).toEqual({
			ok: true,
			path: 'codeWorkTasks:claim',
		});
	});

	it('fails on invalid JSON, arrays, non-objects, or a missing/non-string path', () => {
		expect(readFunctionPath('not json').ok).toBe(false);
		expect(readFunctionPath('[]').ok).toBe(false);
		expect(readFunctionPath('"a string"').ok).toBe(false);
		expect(readFunctionPath(JSON.stringify({ args: [] })).ok).toBe(false);
		expect(readFunctionPath(JSON.stringify({ path: 42 })).ok).toBe(false);
		expect(readFunctionPath(JSON.stringify({ path: '' })).ok).toBe(false);
	});
});
