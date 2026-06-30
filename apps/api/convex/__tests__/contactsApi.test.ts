import { describe, it, expect } from 'vitest';
import {
	formatContactResponse,
	isValidContactId,
	type Contact,
} from '../contacts/api';

describe('formatContactResponse', () => {
	const baseContact: Contact = {
		_id: 'abc123' as Contact['_id'],
		email: 'john@example.com',
		firstName: 'John',
		lastName: 'Doe',
		source: 'api',
		createdAt: 1700000000000,
		updatedAt: 1700001000000,
	};

	it('should transform all fields correctly', () => {
		const result = formatContactResponse(baseContact);

		expect(result).toEqual({
			id: 'abc123',
			email: 'john@example.com',
			firstName: 'John',
			lastName: 'Doe',
			source: 'api',
			createdAt: new Date(1700000000000).toISOString(),
			updatedAt: new Date(1700001000000).toISOString(),
		});
	});

	it('should convert timestamps to ISO string format', () => {
		const result = formatContactResponse(baseContact);

		expect(result.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		expect(result.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	});

	it('should use _id as id in response', () => {
		const result = formatContactResponse(baseContact);
		expect(result.id).toBe(baseContact._id);
	});

	it('should null-coalesce undefined firstName to null', () => {
		const contact = { ...baseContact, firstName: undefined };
		const result = formatContactResponse(contact);
		expect(result.firstName).toBeNull();
	});

	it('should null-coalesce undefined lastName to null', () => {
		const contact = { ...baseContact, lastName: undefined };
		const result = formatContactResponse(contact);
		expect(result.lastName).toBeNull();
	});

	it('should null-coalesce both undefined names to null', () => {
		const contact = { ...baseContact, firstName: undefined, lastName: undefined };
		const result = formatContactResponse(contact);
		expect(result.firstName).toBeNull();
		expect(result.lastName).toBeNull();
	});

	it('should preserve existing firstName and lastName', () => {
		const result = formatContactResponse(baseContact);
		expect(result.firstName).toBe('John');
		expect(result.lastName).toBe('Doe');
	});

	it('should preserve empty string firstName', () => {
		const contact = { ...baseContact, firstName: '' };
		const result = formatContactResponse(contact);
		expect(result.firstName).toBe('');
	});

	it('should preserve source field', () => {
		const apiContact = { ...baseContact, source: 'api' as const };
		const importContact = { ...baseContact, source: 'import' as const };
		const formContact = { ...baseContact, source: 'form' as const };

		expect(formatContactResponse(apiContact).source).toBe('api');
		expect(formatContactResponse(importContact).source).toBe('import');
		expect(formatContactResponse(formContact).source).toBe('form');
	});

	it('should handle Unix epoch timestamp (0)', () => {
		const contact = { ...baseContact, createdAt: 0, updatedAt: 0 };
		const result = formatContactResponse(contact);
		expect(result.createdAt).toBe('1970-01-01T00:00:00.000Z');
		expect(result.updatedAt).toBe('1970-01-01T00:00:00.000Z');
	});

	it('should not include internal fields in response', () => {
		const result = formatContactResponse(baseContact) as unknown as Record<string, unknown>;
		expect(result).not.toHaveProperty('_id');
	});
});

describe('isValidContactId', () => {
	it('should accept Convex-shaped IDs (>=10 alphanumeric/underscore chars)', () => {
		expect(isValidContactId('abc1234567')).toBe(true);
	});

	it('should accept IDs with hyphens (URL-safe base64 alphabet)', () => {
		expect(isValidContactId('abc-1234567')).toBe(true);
	});

	it('should accept uppercase letters', () => {
		expect(isValidContactId('ABC1234567')).toBe(true);
	});

	it('should accept mixed case with underscores', () => {
		expect(isValidContactId('Ab_Cd_1234')).toBe(true);
	});

	it('should reject empty string', () => {
		expect(isValidContactId('')).toBe(false);
	});

	it('should reject IDs with spaces', () => {
		expect(isValidContactId('abc 1234567')).toBe(false);
	});

	it('should reject too-short IDs (under 10 chars)', () => {
		expect(isValidContactId('abc123')).toBe(false);
		expect(isValidContactId('abc-123')).toBe(false);
		expect(isValidContactId('a')).toBe(false);
		expect(isValidContactId('1')).toBe(false);
	});

	it('should reject IDs with dots', () => {
		expect(isValidContactId('abc.1234567')).toBe(false);
	});

	it('should reject IDs with special characters', () => {
		expect(isValidContactId('abc@1234567')).toBe(false);
		expect(isValidContactId('abc!1234567')).toBe(false);
		expect(isValidContactId('abc#1234567')).toBe(false);
	});

	it('should reject email addresses', () => {
		expect(isValidContactId('user@example.com')).toBe(false);
	});

	it('should accept long IDs', () => {
		expect(isValidContactId('a'.repeat(100))).toBe(true);
	});

	it('should reject IDs with slashes', () => {
		expect(isValidContactId('abc/1234567')).toBe(false);
	});
});
