# Firestore Security Specification (`security_spec.md`)

## 1. Data Invariants
1. **Default-Deny Catch-All**: All paths not explicitly matched (`/quant_agents/{agentId}` and `/quant_vault_checkpoints/{checkpointId}`) are unconditionally denied (`allow read, write: if false;`).
2. **Verified Identity & Ownership**: Every write and read requires an authenticated user with `request.auth.token.email_verified == true` and strict ownership (`ownerUid == request.auth.uid`), or bootstrapped admin (`lakeskyler904@gmail.com` with `email_verified == true`).
3. **Path Variable Hardening (`isValidId`)**: All single-document target operations (`get`, `create`, `update`, `delete`) validate document IDs against `^[a-zA-Z0-9_\-]+$` and `.size() <= 128`.
4. **Anti-Update-Gap & Shadow Field Prevention**: `isValidQuantAgentState` and `isValidQuantVaultCheckpoint` enforce `hasAll` and `hasOnly` key checks, string `.size()` bounds, numeric boundaries, and server timestamps (`request.time`).
5. **Query Enforcer on `allow list`**: Every `allow list` rule explicitly evaluates `resource.data.ownerUid == request.auth.uid || isAdmin()` without delegating security to client filters.

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Unauthenticated Write**: `auth = null` attempting `create` on `/quant_agents/agent-hft-15m-kxbtc` -> `PERMISSION_DENIED`.
2. **Unverified Email Spoof**: `auth = { uid: 'u1', token: { email: 'lakeskyler904@gmail.com', email_verified: false } }` -> `PERMISSION_DENIED`.
3. **Owner UID Spoofing on Create**: `auth.uid = 'attacker'` writing `ownerUid: 'victim'` -> `PERMISSION_DENIED`.
4. **Shadow Field Injection on Create**: Payload includes extra key `isSuperAdmin: true` -> Rejected by `.keys().hasOnly(...)` -> `PERMISSION_DENIED`.
5. **Immutable Field Mutation on Update**: Updating `ownerUid` or `createdAt` on `/quant_agents/{agentId}` -> `PERMISSION_DENIED`.
6. **Client Timestamp Forgery**: Providing a past/future `Timestamp` not equal to `request.time` for `createdAt` or `updatedAt` -> `PERMISSION_DENIED`.
7. **ID Poisoning Attack**: Creating a document with a 500-character ID or special characters (`agent/../../etc`) -> Rejected by `isValidId()` -> `PERMISSION_DENIED`.
8. **Value Poisoning on Update**: Updating `allocatedCapitalUsd` with a string `"1000000"` or negative number `-50` -> Rejected by `isValidQuantAgentState(incoming())` -> `PERMISSION_DENIED`.
9. **Unauthorized Cross-Tenant `get`**: Authenticated user `u2` reading `u1`'s checkpoint -> `PERMISSION_DENIED`.
10. **Blanket `list` Scraping**: Authenticated user running an unfiltered collection query across all users' checkpoints -> Rejected by `resource.data.ownerUid == request.auth.uid` -> `PERMISSION_DENIED`.
11. **Invalid Enum State Transition**: Setting `status: 'HACKED_MODE'` outside `['ACTIVE', 'PAUSED', 'KILLED_BY_RISK', 'HALTED_BY_KILL_SWITCH']` -> `PERMISSION_DENIED`.
12. **Unauthorised Action Key Modification on Update**: Modifying unapproved keys during an update action -> Rejected by `affectedKeys().hasOnly(...)` -> `PERMISSION_DENIED`.
