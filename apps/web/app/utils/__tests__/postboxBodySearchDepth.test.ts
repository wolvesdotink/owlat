/**
 * resolveBodySearchDepth / bodySearchDepthHint — what the search box is allowed
 * to claim about how deep it reaches (idea 32).
 *
 * The whole point of the feature is that a search which stops at character 200
 * must SAY so instead of returning an empty result. These pin the two states
 * that are easy to get wrong: an opted-in instance whose backfill has not run
 * (still shallow, must not read as deep), and a job left behind by the opt-out
 * sweep (a completed PURGE, which is the opposite of a ready index).
 */
import { describe, it, expect } from 'vitest';

import {
	resolveBodySearchDepth,
	bodySearchDepthHint,
	type PostboxBodySearchDepth,
} from '../postboxBodySearchDepth';

describe('resolveBodySearchDepth', () => {
	it('reports the instance opt-out regardless of any job left over', () => {
		expect(resolveBodySearchDepth({ isIndexingEnabled: false, job: null })).toBe('disabled');
		expect(
			resolveBodySearchDepth({
				isIndexingEnabled: false,
				job: { mode: 'index', status: 'completed' },
			})
		).toBe('disabled');
	});

	it('is deep only for a COMPLETED index walk', () => {
		expect(
			resolveBodySearchDepth({
				isIndexingEnabled: true,
				job: { mode: 'index', status: 'completed' },
			})
		).toBe('deep');
	});

	it('does not mistake the opt-out sweep for a ready index', () => {
		// A completed purge means the excerpts were just erased.
		expect(
			resolveBodySearchDepth({
				isIndexingEnabled: true,
				job: { mode: 'purge', status: 'completed' },
			})
		).toBe('pending');
	});

	it('separates a walk in flight from one that never ran', () => {
		expect(
			resolveBodySearchDepth({ isIndexingEnabled: true, job: { mode: 'index', status: 'running' } })
		).toBe('indexing');
		expect(resolveBodySearchDepth({ isIndexingEnabled: true, job: null })).toBe('pending');
		expect(resolveBodySearchDepth({ isIndexingEnabled: true, job: undefined })).toBe('pending');
	});

	it('treats a cancelled or failed walk as never-indexed, not as deep', () => {
		expect(
			resolveBodySearchDepth({
				isIndexingEnabled: true,
				job: { mode: 'index', status: 'cancelled' },
			})
		).toBe('pending');
		expect(
			resolveBodySearchDepth({ isIndexingEnabled: true, job: { mode: 'index', status: 'failed' } })
		).toBe('pending');
	});
});

describe('bodySearchDepthHint', () => {
	it('says nothing when the search is as deep as it can be', () => {
		expect(bodySearchDepthHint('deep')).toBeNull();
	});

	it('carries a translation key for every shallow state', () => {
		const shallow: PostboxBodySearchDepth[] = ['disabled', 'indexing', 'pending'];
		for (const depth of shallow) {
			expect(bodySearchDepthHint(depth)?.key).toBe(`dashboard.postbox.search.depth.${depth}`);
		}
	});
});
