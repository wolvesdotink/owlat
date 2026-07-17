/**
 * Conformance pins for the Postbox command-palette provider descriptor.
 *
 * The provider is registered from inside a composable at mount time, so its
 * static contract (id, external-tier priority, route gate) is exported and
 * pinned here without mounting the Postbox layout. If a refactor renames the id,
 * changes the priority, or loosens the route gate to a bare prefix match, one of
 * these assertions fails.
 */
import { describe, it, expect } from 'vitest';
import {
	POSTBOX_COMMAND_PROVIDER_ID,
	POSTBOX_COMMAND_PROVIDER_PRIORITY,
	matchPostboxRoute,
} from '../usePostboxCommandSurface';

describe('Postbox command provider descriptor', () => {
	it('keeps its stable registry id and external-tier priority', () => {
		expect(POSTBOX_COMMAND_PROVIDER_ID).toBe('surface:postbox');
		expect(POSTBOX_COMMAND_PROVIDER_PRIORITY).toBe(15);
	});

	it('gates on the Postbox surface exactly or a nested child, not siblings', () => {
		expect(matchPostboxRoute('/dashboard/postbox')).toBe(true);
		expect(matchPostboxRoute('/dashboard/postbox/inbox')).toBe(true);
		expect(matchPostboxRoute('/dashboard/postbox-archive')).toBe(false);
		expect(matchPostboxRoute('/dashboard/campaigns')).toBe(false);
	});
});
