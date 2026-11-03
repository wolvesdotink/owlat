/**
 * Feature-gated builders for the MCP client management in `mcp/**`.
 *
 * They compose the org-member auth floor with the `mail.mcp` flag, so a member
 * can list, create and revoke MCP clients only while the operator has the
 * server turned on. Turning the flag off also cuts off every existing client:
 * `mcp/access.ts` checks it on every call.
 *
 * Not exported as Convex functions (the leading underscore keeps this module
 * off the public API surface); only imported by sibling `mcp/**` modules.
 */

import { authedMutation, authedQuery, featureGated } from '../lib/authedFunctions';

export const mcpQuery = featureGated(authedQuery, 'mail.mcp');
export const mcpMutation = featureGated(authedMutation, 'mail.mcp');
