import { describe, expect, it } from 'vitest';
import { readAuthTokenAnswer } from '../authTokenResponse';

describe('readAuthTokenAnswer', () => {
	it('reads the token of a token answer', () => {
		expect(readAuthTokenAnswer({ token: 'jwt' })).toEqual({ kind: 'token', token: 'jwt' });
	});

	it.each([
		['an absent token', {}],
		['a null token', { token: null }],
		['an empty token', { token: '' }],
	])('reads %s as no session', (_case, body) => {
		expect(readAuthTokenAnswer(body)).toEqual({ kind: 'token', token: null });
	});

	it.each([
		['a non-string token', { token: 42 }],
		['an object token', { token: { value: 'jwt' } }],
		['a list', ['jwt']],
		['null', null],
		['a body that was not JSON', undefined],
	])('reads %s as unusable, not as signed out', (_case, body) => {
		expect(readAuthTokenAnswer(body)).toEqual({ kind: 'unusable' });
	});

	it('ignores fields it does not know', () => {
		expect(readAuthTokenAnswer({ token: 'jwt', expiresAt: 1 })).toEqual({
			kind: 'token',
			token: 'jwt',
		});
	});
});
