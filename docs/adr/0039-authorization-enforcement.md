# Authorization enforcement — role-bearing wrappers + permission lint

**Status:** accepted

## Context

ADR-0036's sibling work made *authentication* secure-by-default: every public
Convex function goes through `authedQuery`/`authedMutation`/`authedAction` (or an
explicit, `// public:`-commented opt-out), and `scripts/check-public-functions.sh`
fails CI on a bare `query`/`mutation`/`action`.

But the wrappers only enforce the *floor* — `authedMutation` requires an
authenticated **org member of any role** (including `editor`). The *authorization*
decision (which role may run this write) was a hand-written
`requirePermission(hasPermission(role, '<scope>:<verb>'))` convention inside each
handler, with **no CI gate**. A security review of all 253 `authedMutation` /
`authedAction` call sites found this convention had silently lapsed:

| Site | Was | Risk |
|---|---|---|
| `domains/trackingDomains.ts` (add/verify/markVerified/remove) | `getMutationContext` only | any editor edits sending-reputation infra |
| `topics/bulk.ts` (addContacts/removeContacts) | `getUserIdFromSession` only | any editor bulk-edits topic membership |
| `storage.ts:deleteFile` | auth floor only | any editor deletes media/block blobs (vs `media:manage` on `mediaAssets.remove`) |
| `semanticFiles.ts` (create/update/remove) | no check | any editor CRUDs the knowledge base |
| `visualizationAgent.ts` (create/togglePin/remove) | no check (`createdBy:'user'` placeholder) | any editor mutates shared analytics |
| `emailSends.ts:create` | auth floor only | forge campaign send records (function had **no callers**) |
| `unifiedMessages.ts:sendChatMessage` | no check | any editor posts on a customer thread |

The remaining flagged sites *did* gate correctly, but through a **diversity of
mechanisms** the grep-free convention never made visible: org-role RBAC
(`requirePermission`), per-user mail ownership (`loadOwnedMailbox`,
`loadOwnedMessage`), chat membership (`assertCanReadRoom`/`…WriteRoom`/`…AdministerRoom`),
platform-operator (`requirePlatformAdmin`), and self-scoping (`args.userId ===
session.userId`).

## Decision

Make the authorization decision **mandatory and CI-enforced**, mirroring the
authentication rule.

1. **Role-bearing wrappers** in `lib/authedFunctions.ts` — `adminMutation`,
   `ownerMutation`, `adminQuery` — that bake the role check into the wrapper
   (`requireAdminContext` / `requireOwnerContext` / `requireOrgPermission(…,
   'organization:manage')`). The floor becomes "admin", so the common admin-only
   write needs no in-handler `requirePermission`.

2. **`scripts/check-permissions.sh`** (wired into `bun run lint`, baseline 0). A
   state-changing public function passes only if it does one of:
   - uses a role-bearing wrapper (`adminMutation` / `ownerMutation`); or
   - calls a recognized gate token in its body — `requirePermission` /
     `requireAdminContext` / `requireOwnerContext` / `requireOrgPermission` /
     `loadOwnedMailbox` / `loadOwnedMessage` / `assertCanReadRoom` /
     `assertCanWriteRoom` / `assertCanAdministerRoom` / `requirePlatformAdmin`; or
   - carries an explicit `// authz: <reason>` (gate lives elsewhere — e.g. a
     delegated internal mutation, a self-scope check) or `// all-members:
     <reason>` (intentionally open to every member) comment.

   A forgotten authorization check is a privilege-escalation bug, not style
   drift, so — like `check-public-functions.sh` — the baseline is 0 and one
   violation fails CI outright.

3. **Close the real gaps** by adding the appropriate role gate, and **document
   the legitimate non-RBAC gates** with `// authz:` / `// all-members:` comments
   so every authed write now states *who* may run it.

## Considered options

1. **Gate-token / opt-out lint** *(chosen)* — passes the (majority) sites that
   already gate correctly through their diverse mechanisms untouched, and
   surfaces exactly the sites with no decision. Low churn, no behavior change to
   correct code.
2. **Require a role-bearing wrapper everywhere** — would force migrating all 253
   sites and cannot express per-user ownership / chat-membership gates. Rejected:
   high churn and risk for no added safety over option 1.
3. **Wrappers only, no lint** — adds the ergonomics but leaves the next role-less
   mutation undetected. Rejected: doesn't close the actual gap (enforcement).

## Consequences

- A new `authedMutation`/`authedAction` that makes no authorization decision
  fails CI. The check is leak-safe: the opt-out comment is recognized inside the
  body or in the contiguous `//` block directly above the export, and reset by
  any non-comment line.
- **Behavior change:** the real-gap writes above now require an owner/admin (or
  `campaigns:send` for `emailSends.create`). Editors lose these capabilities —
  intended, since editors already cannot send campaigns or manage content.
- Diverse legitimate gates are now greppable via `// authz:` / `// all-members:`.
- When a new gate helper is introduced, add its name to the gate-token regex in
  `check-permissions.sh`.
- The shared-inbox restriction (ADR-0040) is the first adopter of `adminMutation`
  / `adminQuery`.
