import { describe, expect, it } from 'vitest';
import { postboxFilterQueryFrom } from '../postboxFilterFromMessage';

/** "Create filter from this message" seeds the builder from the sender and the bare subject. */
describe('postboxFilterQueryFrom', () => {
	it('carries the sender and the subject without its Re:/Fwd: run', () => {
		expect(
			postboxFilterQueryFrom({
				fromAddress: 'billing@example.com',
				subject: 'Re: Fwd: AW: Invoice 4471',
			})
		).toEqual({ filterFrom: 'billing@example.com', filterSubject: 'Invoice 4471' });
	});

	it('leaves out what the message does not have', () => {
		expect(postboxFilterQueryFrom({ fromAddress: 'billing@example.com', subject: 'RE:' })).toEqual({
			filterFrom: 'billing@example.com',
		});
		expect(postboxFilterQueryFrom({ subject: 'Invoice 4471' })).toEqual({
			filterSubject: 'Invoice 4471',
		});
	});

	it('gives nothing to seed when the message has neither', () => {
		expect(postboxFilterQueryFrom({ subject: '  ' })).toBeNull();
		expect(postboxFilterQueryFrom({})).toBeNull();
	});
});
