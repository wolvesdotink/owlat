import type { convexTest } from 'convex-test';
import { internal } from '../../_generated/api';

type TestClient = Pick<ReturnType<typeof convexTest>, 'query'>;

export type PublicKeyProjection = {
	readonly fingerprint: string;
	readonly publicKeyArmored: string;
} | null;

/** Test-only public projection of the production internal address-key read. */
export async function readAddressPublicKey(
	client: TestClient,
	address: string
): Promise<PublicKeyProjection> {
	const row = await client.query(internal.e2ee.keys.getAddressKeyInternal, { address });
	return row ? { fingerprint: row.fingerprint, publicKeyArmored: row.publicKeyArmored } : null;
}

/** Test-only public projection of the production internal instance-identity read. */
export async function readInstancePublicKey(client: TestClient): Promise<PublicKeyProjection> {
	const row = await client.query(internal.e2ee.keys.getInstanceIdentityInternal, {});
	return row ? { fingerprint: row.fingerprint, publicKeyArmored: row.publicKeyArmored } : null;
}
