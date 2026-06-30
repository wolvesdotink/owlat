import { describe, it, expect } from 'vitest';
import {
	OwlatError,
	AuthenticationError,
	RateLimitError,
	NotFoundError,
	ValidationError,
	ConflictError,
	ForbiddenError,
	InvalidStateError,
	LimitReachedError,
} from '../src/errors';
import type { RateLimitInfo } from '../src/types/common';

const rateLimit: RateLimitInfo = { limit: 100, remaining: 99, reset: 1700000000 };

describe('OwlatError', () => {
	it('should set name, message, code, statusCode', () => {
		const err = new OwlatError('Something broke', 'server_error', 500);
		expect(err.name).toBe('OwlatError');
		expect(err.message).toBe('Something broke');
		expect(err.code).toBe('server_error');
		expect(err.statusCode).toBe(500);
	});

	it('should store rateLimit when provided', () => {
		const err = new OwlatError('err', 'code', 500, rateLimit);
		expect(err.rateLimit).toEqual(rateLimit);
	});

	it('should store data (Operation error specifics) when provided', () => {
		const err = new OwlatError('err', 'invalid_input', 400, undefined, { field: 'email' });
		expect(err.data).toEqual({ field: 'email' });
	});

	it('should leave data undefined when not provided', () => {
		const err = new OwlatError('err', 'internal', 500);
		expect(err.data).toBeUndefined();
	});

	it('should be instanceof Error', () => {
		const err = new OwlatError('err', 'code', 500);
		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(OwlatError);
	});
});

describe('AuthenticationError', () => {
	it('should have statusCode 401', () => {
		const err = new AuthenticationError('Invalid API key', 'unauthorized');
		expect(err.name).toBe('AuthenticationError');
		expect(err.statusCode).toBe(401);
		expect(err.code).toBe('unauthorized');
	});

	it('should be instanceof OwlatError and Error', () => {
		const err = new AuthenticationError('msg', 'code');
		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(OwlatError);
		expect(err).toBeInstanceOf(AuthenticationError);
	});

	it('should store rateLimit', () => {
		const err = new AuthenticationError('msg', 'code', rateLimit);
		expect(err.rateLimit).toEqual(rateLimit);
	});
});

describe('ValidationError', () => {
	it('should have statusCode 400', () => {
		const err = new ValidationError('Invalid email', 'invalid_email');
		expect(err.name).toBe('ValidationError');
		expect(err.statusCode).toBe(400);
		expect(err.code).toBe('invalid_email');
	});

	it('should be instanceof OwlatError and Error', () => {
		const err = new ValidationError('msg', 'code');
		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(OwlatError);
		expect(err).toBeInstanceOf(ValidationError);
	});
});

describe('NotFoundError', () => {
	it('should have statusCode 404 and default code', () => {
		const err = new NotFoundError('Contact not found');
		expect(err.name).toBe('NotFoundError');
		expect(err.statusCode).toBe(404);
		expect(err.code).toBe('not_found');
	});

	it('should accept custom code', () => {
		const err = new NotFoundError('Template missing', 'template_not_found');
		expect(err.code).toBe('template_not_found');
	});

	it('should be instanceof OwlatError and Error', () => {
		const err = new NotFoundError('msg');
		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(OwlatError);
		expect(err).toBeInstanceOf(NotFoundError);
	});
});

describe('ConflictError', () => {
	it('should have statusCode 409 and default code', () => {
		const err = new ConflictError('Email already exists');
		expect(err.name).toBe('ConflictError');
		expect(err.statusCode).toBe(409);
		expect(err.code).toBe('conflict');
	});

	it('should accept custom code', () => {
		const err = new ConflictError('Duplicate', 'email_conflict');
		expect(err.code).toBe('email_conflict');
	});

	it('should be instanceof OwlatError and Error', () => {
		const err = new ConflictError('msg');
		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(OwlatError);
		expect(err).toBeInstanceOf(ConflictError);
	});
});

describe('ForbiddenError', () => {
	it('should have statusCode 403 and default code', () => {
		const err = new ForbiddenError('Account suspended');
		expect(err.name).toBe('ForbiddenError');
		expect(err.statusCode).toBe(403);
		expect(err.code).toBe('forbidden');
	});

	it('should be instanceof OwlatError and Error', () => {
		const err = new ForbiddenError('msg');
		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(OwlatError);
		expect(err).toBeInstanceOf(ForbiddenError);
	});
});

describe('InvalidStateError', () => {
	it('should have statusCode 422 and default code', () => {
		const err = new InvalidStateError('Sending domain is not verified.');
		expect(err.name).toBe('InvalidStateError');
		expect(err.statusCode).toBe(422);
		expect(err.code).toBe('invalid_state');
	});

	it('should carry error data specifics', () => {
		const err = new InvalidStateError('blocked', 'invalid_state', undefined, {
			reason: 'recipient_blocked',
		});
		expect(err.data).toEqual({ reason: 'recipient_blocked' });
	});

	it('should be instanceof OwlatError and Error', () => {
		const err = new InvalidStateError('msg');
		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(OwlatError);
		expect(err).toBeInstanceOf(InvalidStateError);
	});
});

describe('LimitReachedError', () => {
	it('should have statusCode 402 and default code', () => {
		const err = new LimitReachedError('Plan limit reached');
		expect(err.name).toBe('LimitReachedError');
		expect(err.statusCode).toBe(402);
		expect(err.code).toBe('limit_reached');
	});

	it('should be instanceof OwlatError and Error', () => {
		const err = new LimitReachedError('msg');
		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(OwlatError);
		expect(err).toBeInstanceOf(LimitReachedError);
	});
});

describe('RateLimitError', () => {
	it('should have statusCode 429 and fixed code', () => {
		const err = new RateLimitError('Too many requests', 30);
		expect(err.name).toBe('RateLimitError');
		expect(err.statusCode).toBe(429);
		expect(err.code).toBe('rate_limited');
	});

	it('should store retryAfter', () => {
		const err = new RateLimitError('Too many requests', 60);
		expect(err.retryAfter).toBe(60);
	});

	it('should store rateLimit', () => {
		const err = new RateLimitError('msg', 10, rateLimit);
		expect(err.rateLimit).toEqual(rateLimit);
	});

	it('should be instanceof OwlatError and Error', () => {
		const err = new RateLimitError('msg', 10);
		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(OwlatError);
		expect(err).toBeInstanceOf(RateLimitError);
	});
});
