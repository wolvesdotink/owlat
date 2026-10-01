// cluster-key-slot (an ioredis dependency) ships no types; the feedback
// provenance test uses it to assert that its keys share one cluster slot.
declare module 'cluster-key-slot' {
	export default function keySlot(key: string | Buffer): number;
}
