/**
 * The relay-identity panel is one self-querying tag embedded on three delivery
 * pages. Its rendering is covered by real mounts in
 * `components/delivery/__tests__/RelayDomainStatus.test.ts`; what only a
 * source read can say is that every page still embeds it as that one tag.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const page = (name: string): string => readFileSync(resolve(here, `../${name}`), 'utf8');

describe('the relay-identity panel on the delivery pages', () => {
	it.each(['provider-routing.vue', 'domains.vue', 'migrate.vue'])(
		'is embedded in %s as one self-querying tag',
		(name) => {
			expect(page(name)).toContain('<DeliveryRelayDomainStatus />');
		}
	);
});
