import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPERATION_EXAMPLES } from '@owlat/public-contract/schemas';
import { createTestClient, mockFetch } from './helpers';
import { ValidationError } from '../src/errors';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('BrandKitResource', () => {
	it('sends only the fields it is given, and returns the whole kit', async () => {
		const spy = mockFetch({ status: 200, body: OPERATION_EXAMPLES.updateBrandKit.response });
		const kit = await createTestClient().brandKit.update({
			headingFontFamily: "'Montserrat', Arial, sans-serif",
		});
		const [url, init] = spy.mock.calls[0]!;
		expect(new URL(String(url)).pathname).toBe('/api/v1/brand-kit');
		expect(init?.method).toBe('PUT');
		expect(JSON.parse(String(init?.body))).toEqual({
			headingFontFamily: "'Montserrat', Arial, sans-serif",
		});
		expect(kit).toEqual(OPERATION_EXAMPLES.updateBrandKit.response.data);
	});

	it('throws ValidationError naming the field the server refused', async () => {
		mockFetch({
			status: 400,
			body: {
				error: {
					category: 'invalid_input',
					message: 'Every brand colour must be a hex colour such as #c4785a',
					data: { field: 'primaryColor' },
				},
			},
		});
		const error = await createTestClient()
			.brandKit.update({ primaryColor: 'teal' })
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ValidationError);
		expect((error as ValidationError).data).toEqual({ field: 'primaryColor' });
	});
});
