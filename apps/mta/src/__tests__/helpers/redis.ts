/**
 * Test helper for creating mock Redis instances
 */
import Redis from 'ioredis-mock';

export function createTestRedis(): InstanceType<typeof Redis> {
	return new Redis();
}

export async function flushTestRedis(redis: InstanceType<typeof Redis>): Promise<void> {
	await redis.flushall();
}
