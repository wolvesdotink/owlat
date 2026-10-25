import { decodeJsonValue, parserDecoder } from '@owlat/worker-protocol/decodeJson';
import { isRecord } from '@owlat/shared/utils/guards';
import type { InstanceInfo } from './workspaceTypes';

/**
 * A string field the instance may leave out (an older server, an unset
 * company name): absent reads as ''; present, it has to be a string.
 */
function optionalString(value: unknown): string | null {
	if (value === undefined || value === null) return '';
	return typeof value === 'string' ? value : null;
}

/**
 * GET /api/instance-info's body. The two Convex URLs are what a workspace
 * cannot work without, so both must be nonempty strings; the rest default to
 * ''. Fields this build does not know are ignored.
 */
const instanceInfoDecoder = parserDecoder((value): InstanceInfo | null => {
	if (!isRecord(value)) return null;
	const { convexUrl, convexSiteUrl } = value;
	if (typeof convexUrl !== 'string' || convexUrl === '') return null;
	if (typeof convexSiteUrl !== 'string' || convexSiteUrl === '') return null;
	const name = optionalString(value['name']);
	const siteUrl = optionalString(value['siteUrl']);
	const deploymentMode = optionalString(value['deploymentMode']);
	if (name === null || siteUrl === null || deploymentMode === null) return null;
	return { name, convexUrl, convexSiteUrl, siteUrl, deploymentMode };
}, '$: expected instance info with convexUrl and convexSiteUrl');

/**
 * The instance metadata in a discovery response body already read as JSON,
 * or null when it is unusable (`undefined` stands for a body that was not JSON).
 */
export function readInstanceInfo(body: unknown): InstanceInfo | null {
	const decoded = decodeJsonValue(body, instanceInfoDecoder);
	return decoded.ok ? decoded.value : null;
}
