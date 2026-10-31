/**
 * The benchmark fixture's wire copy: a JSON round trip, as the Convex client
 * delivers every update, checked to still be a list page. The structural
 * sharing benchmark and the API fixture contract both depend on its semantics.
 */
import { describe, expect, it } from 'vitest';
import { listUpdates, wireCopy, type ListPage } from '../perf-bench/postboxListPage';

const page = (): ListPage => structuredClone(listUpdates(8)[0]!.prev);

describe('the list page wire copy', () => {
	it('copies with JSON semantics: equal content, fresh nested objects', () => {
		const prev = page();
		const copy = wireCopy(prev);
		expect(JSON.stringify(copy)).toBe(JSON.stringify(prev));
		expect(copy).not.toBe(prev);
		expect(copy.messages).not.toBe(prev.messages);
		expect(copy.messages[0]).not.toBe(prev.messages[0]);
		expect(copy.messages[0]!.toAddresses).not.toBe(prev.messages[0]!.toAddresses);
		const withBrief = copy.messages.findIndex((row) => row.briefTop);
		expect(withBrief).toBeGreaterThanOrEqual(0);
		expect(copy.messages[withBrief]!.briefTop).not.toBe(prev.messages[withBrief]!.briefTop);
	});

	it('drops undefined properties, as the wire does', () => {
		const prev = page();
		prev.messages[0]!.fromName = undefined;
		prev.messages[0]!.followUp = { remindAt: 1, dueAt: undefined, watched: false };
		const copy = wireCopy(prev);
		expect('fromName' in copy.messages[0]!).toBe(false);
		expect('dueAt' in copy.messages[0]!.followUp!).toBe(false);
	});

	it('refuses a page that is no longer a list page', () => {
		const broken = page() as unknown as { messages: Record<string, unknown>[]; hasMore: unknown };
		broken.messages[2]!['receivedAt'] = '1792000000000';
		expect(() => wireCopy(broken as unknown as ListPage)).toThrow(
			'list page.messages[2].receivedAt must be a finite number'
		);
		const flagged = page() as unknown as { hasMore: unknown };
		flagged.hasMore = 'yes';
		expect(() => wireCopy(flagged as unknown as ListPage)).toThrow(
			'list page.hasMore must be a boolean'
		);
		const sealed = page() as unknown as { messages: Record<string, unknown>[] };
		sealed.messages[0]!['inboundEncryptionInfo'] = { isSealed: true, isDecrypted: 'no' };
		expect(() => wireCopy(sealed as unknown as ListPage)).toThrow(
			'list page.messages[0].inboundEncryptionInfo must be a sealed-message state'
		);
	});
});
