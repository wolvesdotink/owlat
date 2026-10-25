import { expect, it } from 'vitest';
import { decodePages, jsonPages, isTransientAPIError } from '../ci/github';
import { arrayOf, object, string } from '../json';
it('reads concatenated object and array API pages without treating string braces as syntax', () => {
	expect(jsonPages('{"jobs":[{"name":"a { \\\""}]}\n{"jobs":[]}')).toEqual([
		{ jobs: [{ name: 'a { "' }] },
		{ jobs: [] },
	]);
	expect(jsonPages('[{"x":1}]\n[{"x":2}]').flat()).toEqual([{ x: 1 }, { x: 2 }]);
	expect(() => jsonPages('{"jobs":[')).toThrow();
	expect(() => jsonPages('')).toThrow();
});

it('retries transient HTTP failures without treating permissions or failed checks as transient', () => {
	expect(isTransientAPIError('HTTP 504')).toBe(true);
	expect(isTransientAPIError('HTTP 429')).toBe(true);
	expect(isTransientAPIError('HTTP 403')).toBe(false);
	expect(isTransientAPIError('Main CI failed')).toBe(false);
});

it('decodes every page before flattening, for list pages and envelope pages alike', () => {
	const releases = arrayOf(object({ tag_name: string }));
	expect(decodePages('[{"tag_name":"v1"}]\n[{"tag_name":"v2"}]', releases, 'releases')).toEqual([
		{ tag_name: 'v1' },
		{ tag_name: 'v2' },
	]);
	const jobs = (page: unknown, path: string) =>
		object({ jobs: arrayOf(object({ name: string })) })(page, path).jobs;
	expect(
		decodePages('{"total_count":2,"jobs":[{"name":"a"}]}\n{"jobs":[{"name":"b"}]}', jobs, 'jobs')
	).toEqual([{ name: 'a' }, { name: 'b' }]);
});

it('refuses a page of the wrong shape, naming the page', () => {
	const releases = arrayOf(object({ tag_name: string }));
	expect(() =>
		decodePages('[{"tag_name":"v1"}]\n{"message":"Not Found"}', releases, 'releases')
	).toThrow('releases page 2 must be an array');
	expect(() => decodePages('[{"tag_name":1}]', releases, 'releases')).toThrow(
		'releases page 1[0].tag_name must be a string'
	);
	const jobs = (page: unknown, path: string) =>
		object({ jobs: arrayOf(object({ name: string })) })(page, path).jobs;
	expect(() => decodePages('[{"name":"a"}]', jobs, 'jobs')).toThrow(
		'jobs page 1 must be an object'
	);
});
