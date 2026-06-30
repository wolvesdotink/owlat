/**
 * Unit tests for the shared response helpers — the locked envelope shape
 * is the contract every public token endpoint and every API-key endpoint
 * shares post-deepening. These tests pin the shape without going through
 * either factory.
 *
 * See docs/adr/0030-public-token-endpoint-module.md.
 */

import { ConvexError } from 'convex/values';
import { describe, expect, it } from 'vitest';
import {
	errorResponse,
	errorResponseFromThrow,
	jsonResponse,
	methodNotAllowed,
	publicCorsHeaders,
} from '../httpResponse';

describe('publicCorsHeaders', () => {
	it('returns wildcard allow-origin', () => {
		const headers = publicCorsHeaders('GET, OPTIONS');
		expect(headers['Access-Control-Allow-Origin']).toBe('*');
	});

	it('passes through the requested methods', () => {
		expect(publicCorsHeaders('GET, OPTIONS')['Access-Control-Allow-Methods']).toBe(
			'GET, OPTIONS',
		);
		expect(publicCorsHeaders('POST, OPTIONS')['Access-Control-Allow-Methods']).toBe(
			'POST, OPTIONS',
		);
		expect(publicCorsHeaders('GET, POST, OPTIONS')['Access-Control-Allow-Methods']).toBe(
			'GET, POST, OPTIONS',
		);
	});
});

describe('jsonResponse', () => {
	it('serializes data as JSON with default status 200', async () => {
		const response = jsonResponse({ hello: 'world' });
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('application/json');
		await expect(response.json()).resolves.toEqual({ hello: 'world' });
	});

	it('respects the explicit status', () => {
		const response = jsonResponse({ ok: true }, 201);
		expect(response.status).toBe(201);
	});

	it('merges in CORS headers when provided', () => {
		const cors = publicCorsHeaders('GET, OPTIONS');
		const response = jsonResponse({}, 200, cors);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
		expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS');
	});

	it('omits CORS headers when no map is passed', () => {
		const response = jsonResponse({});
		expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
	});
});

describe('errorResponse', () => {
	it('emits the locked envelope shape with the category', async () => {
		const response = errorResponse('invalid_input', 'Bad email');
		expect(response.headers.get('Content-Type')).toBe('application/json');
		await expect(response.json()).resolves.toEqual({
			error: { category: 'invalid_input', message: 'Bad email' },
		});
	});

	it('derives the HTTP status from the category', () => {
		expect(errorResponse('unauthenticated', 'x').status).toBe(401);
		expect(errorResponse('forbidden', 'x').status).toBe(403);
		expect(errorResponse('not_found', 'x').status).toBe(404);
		expect(errorResponse('invalid_input', 'x').status).toBe(400);
		expect(errorResponse('already_exists', 'x').status).toBe(409);
		expect(errorResponse('conflict', 'x').status).toBe(409);
		expect(errorResponse('invalid_state', 'x').status).toBe(422);
		expect(errorResponse('rate_limited', 'x').status).toBe(429);
		expect(errorResponse('limit_reached', 'x').status).toBe(402);
		expect(errorResponse('internal', 'x').status).toBe(500);
	});

	it('carries data through to the body when provided', async () => {
		const response = errorResponse('rate_limited', 'Slow down', { retryAfter: 30 });
		const body = await response.json();
		expect(body.error.category).toBe('rate_limited');
		expect(body.error.data).toEqual({ retryAfter: 30 });
	});

	it('omits data when not provided', async () => {
		const body = await errorResponse('not_found', 'Gone').json();
		expect('data' in body.error).toBe(false);
	});

	it('includes CORS headers when provided', () => {
		const cors = publicCorsHeaders('POST, OPTIONS');
		const response = errorResponse('invalid_input', 'Bad request', undefined, cors);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
		expect(response.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS');
	});
});

describe('errorResponseFromThrow', () => {
	it('honors a ConvexError carrying an Operation error (category + status)', async () => {
		const response = errorResponseFromThrow(
			new ConvexError({ category: 'not_found', message: 'Contact not found' }),
		);
		expect(response.status).toBe(404);
		const body = await response.json();
		expect(body.error).toEqual({ category: 'not_found', message: 'Contact not found' });
	});

	it('preserves data carried on the Operation error', async () => {
		const response = errorResponseFromThrow(
			new ConvexError({
				category: 'invalid_state',
				message: 'Published',
				data: { action: 'unpublish' },
			}),
		);
		expect(response.status).toBe(422);
		const body = await response.json();
		expect(body.error.data).toEqual({ action: 'unpublish' });
	});

	it('collapses a non-Operation throw to internal (500)', async () => {
		const response = errorResponseFromThrow(new Error('boom'));
		expect(response.status).toBe(500);
		const body = await response.json();
		expect(body.error.category).toBe('internal');
		expect(body.error.message).toBe('boom');
	});
});

describe('methodNotAllowed', () => {
	it('returns 405 with an uncategorized error envelope', async () => {
		const response = methodNotAllowed();
		expect(response.status).toBe(405);
		const body = await response.json();
		expect(body.error.message).toBe('Method not allowed');
		expect('category' in body.error).toBe(false);
	});
});
