// The classifier lives in @owlat/shared so the MTA's MTA-STS policy fetch uses
// the same blocklist as the backend's SSRF guard.
export { expandIpv6, isDisallowedIpAddress } from '@owlat/shared/ipBlocklist';
