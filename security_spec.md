# Firestore Security Specification (`security_spec.md`)

## 1. Data Invariants
1. **Default-Deny Catch-All**: All paths not explicitly matched (`/quant_agents/{agentId}`, `/quant_vault_checkpoints/{checkpointId}`, `/system_controls/{controlId}`) are unconditionally denied (`allow read, write: if false;`).
2. **Verified Identity & Custom Claim Admin RBAC**: Every read and write requires an authenticated user with `request.auth.token.email_verified == true`. Admin privileges strictly require the custom claim `request.auth.token.admin == true` (no hardcoded email addresses).
3. **Server-Only Agent Telemetry & Status Fields**: On `/quant_agents/{agentId}`, `create` is denied to clients (`allow create: if false;`, written exclusively via Firebase Admin SDK). On `update`, owners may ONLY edit `name`, `targetSymbol`, `allocatedCapitalUsd` (`<= 1000`), `kalshiAllocatedUsd` (`<= 500`), `publicAllocatedUsd` (`<= 500`), and `updatedAt` (`== request.time`). Clients are strictly forbidden from modifying `status`, `sharpe`, `winRate`, `totalPnlUsd`, or `predictionMarketDataSource`.
4. **Terminal Risk State Lock**: Once an agent's `status` is `KILLED_BY_RISK` or `HALTED_BY_KILL_SWITCH`, client updates are completely blocked (`!(existing().status in ['KILLED_BY_RISK', 'HALTED_BY_KILL_SWITCH'])`). Only the server (Admin SDK) can transition an agent into or out of risk-halted states.
5. **Path Variable Hardening (`isValidId`)**: All single-document target operations (`get`, `create`, `update`, `delete`) validate document IDs against `^[a-zA-Z0-9_\-]+$` and `.size() <= 128`.
6. **Query Enforcer on `allow list`**: Every `allow list` rule explicitly evaluates `resource.data.ownerUid == request.auth.uid || isAdmin()` without delegating security to client filters.

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Unauthenticated Write**: `auth = null` attempting `update` on `/quant_agents/agent-hft-15m-kxbtc` -> `PERMISSION_DENIED`.
2. **Forged Email Admin Spoof**: `auth = { uid: 'u1', token: { email: 'admin@example.com', email_verified: true } }` without `token.admin == true` -> `PERMISSION_DENIED`.
3. **Client Attempt to Create Agent**: Authenticated user attempting `create` on `/quant_agents/agent-1` -> Rejected by `allow create: if false` (Admin SDK only) -> `PERMISSION_DENIED`.
4. **Client Attempt to Mutate `status`, `sharpe`, `winRate`, or `totalPnlUsd`**: Owner attempting `update` on `/quant_agents/agent-1` modifying `status: 'ACTIVE'` or `totalPnlUsd: 99999` -> Rejected by `affectedKeys().hasOnly(['name', 'targetSymbol', 'allocatedCapitalUsd', 'kalshiAllocatedUsd', 'publicAllocatedUsd', 'updatedAt'])` -> `PERMISSION_DENIED`.
5. **Client Attempt to Clear `KILLED_BY_RISK` / `HALTED_BY_KILL_SWITCH`**: Owner attempting any `update` when `existing().status == 'HALTED_BY_KILL_SWITCH'` -> Rejected by terminal lock `!(existing().status in ['KILLED_BY_RISK', 'HALTED_BY_KILL_SWITCH'])` -> `PERMISSION_DENIED`.
6. **Allocation Cap Overflow**: Owner attempting `update` with `allocatedCapitalUsd: 50000` (`> 1000` rule cap) -> Rejected by `isValidQuantAgentState(incoming())` -> `PERMISSION_DENIED`.
7. **Shadow Field Injection**: Payload includes extra key `isSuperAdmin: true` -> Rejected by `.keys().hasOnly(...)` -> `PERMISSION_DENIED`.
8. **Immutable Field Mutation on Update**: Updating `ownerUid` or `createdAt` -> `PERMISSION_DENIED`.
9. **Client Timestamp Forgery**: Providing a past/future `Timestamp` not equal to `request.time` for `updatedAt` -> `PERMISSION_DENIED`.
10. **ID Poisoning Attack**: Targeting a document with a 500-character ID or special characters (`agent/../../etc`) -> Rejected by `isValidId()` -> `PERMISSION_DENIED`.
11. **Unauthorized Cross-Tenant `get` / `list`**: Authenticated user `u2` reading `u1`'s agent or checkpoint -> `PERMISSION_DENIED`.
12. **Non-Admin Kill-Switch Tampering**: Standard user attempting `update` on `/system_controls/kill_switch` to set `globalKillSwitchActive: false` -> Rejected by `isAdmin()` -> `PERMISSION_DENIED`.
