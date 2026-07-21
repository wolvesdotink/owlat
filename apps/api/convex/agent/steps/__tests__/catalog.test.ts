import { describe, expect, it } from 'vitest';
import { AGENT_STEP_KINDS, CORE_AGENT_STEP_DEFINITIONS, pluginStepsFollowing } from '../catalog';
import { CORE_STEP_MODULES } from '..';

describe('agent step catalog conformance', () => {
	it('derives the exact built-in kind list and executable registry from one catalog', () => {
		const expected = [
			'security_scan',
			'context_retrieval',
			'classify',
			'clarify',
			'draft',
			'route',
		];
		expect(CORE_AGENT_STEP_DEFINITIONS.map((definition) => definition.kind)).toEqual(expected);
		expect(AGENT_STEP_KINDS).toEqual(expected);
		expect(Object.keys(CORE_STEP_MODULES)).toEqual(expected);
		expect(Object.values(CORE_STEP_MODULES).map((module) => module.kind)).toEqual(expected);
	});

	it('has no hosted insertion work in a zero-plugin composition', () => {
		for (const kind of AGENT_STEP_KINDS) expect(pluginStepsFollowing(kind)).toEqual([]);
	});
});
