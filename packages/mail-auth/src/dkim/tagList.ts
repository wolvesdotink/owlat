/**
 * The RFC 6376 §3.2 `tag=value` list grammar lives in `@owlat/shared/dnsTagList`
 * so the Convex backend's DNS verifier and deliverability checklist parse
 * published key records with the same rules as the DKIM/ARC verifier here.
 * Re-exported so `messageSignature.ts`, `keyRecord.ts` and `arc/chain.ts` keep
 * their local import.
 */
export { parseTagList, type TagListOptions } from '@owlat/shared/dnsTagList';
