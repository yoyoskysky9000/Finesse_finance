# Implementation Plan: Google Drive App Copy & Vault Sync

## 1. Overview & Goals
Enable users to connect their Google account and copy the complete **QuantPulse (Finesse_finance)** application—including its full source codebase, live quantitative state, strategy backtest benchmarks, Kalshi & Public.com execution ledger, and the Master Quant Playbook—directly into a dedicated, versioned folder in their Google Drive.

Because the clarifying questions were skipped, we will implement the recommended comprehensive default workflow:
- **Complete App Copy Payload**: Exports a structured Google Drive folder (`QuantPulse_Finesse_Finance_Copy_<TIMESTAMP>`) containing:
  1. `quantpulse-app-bundle.json` — Complete portable snapshot of live engine state, active indicator weights, tournament leaderboard, Kalshi 15m ledger, and Public.com BTC limit order book.
  2. `quantpulse-source-archive.json` — Complete application source tree (`server.ts`, `package.json`, `src/**`) packaged for instant portability and inspection.
  3. `Master_Quant_Playbook_Report.md` — Formatted Markdown playbook & live risk telemetry summary.
- **Versioned Drive Copies & Overwrite Protection**: Creates timestamped versioned copies by default and provides a browsing table of existing Google Drive app copies with an explicit confirmation modal before any overwrite or delete action.

---

## 2. Authentication & Google Workspace OAuth Architecture
Following the AI Studio Workspace Integration guidelines:
- **Provisioning**: Finalize OAuth client provisioning via `set_up_oauth` (`userConfirmedInUI: true`) with the approved Google Drive scopes (`drive`, `drive.file`, `drive.appdata`, `drive.metadata`, `drive.readonly`, etc.) and provision Firebase Authentication (`firebase` SDK + `firebase-applet-config.json`) so `GoogleAuthProvider` can authenticate in the preview iframe.
- **Client-Side Token Management**:
  - Authenticate via Firebase `signInWithPopup(auth, googleProvider)` requesting `https://www.googleapis.com/auth/drive.file` and `https://www.googleapis.com/auth/drive`.
  - Store the Google OAuth `accessToken` **strictly in React memory** (never in `localStorage` or `sessionStorage`).
  - Automatically handle `401 Unauthorized` responses by clearing the cached in-memory token and prompting re-authentication.
  - Render the official Google-branded **"Sign in with Google"** button whenever the user is unauthenticated or when the Drive token has expired.

---

## 3. Planned Features & User Experience
1. **Google Drive Copy & Vault Workspace Panel (`src/components/GoogleDriveVaultModal.tsx` & Header Action)**:
   - Accessible directly from the top command bar (`Copy App to Drive` trigger) and as a dedicated control panel.
   - **Connection Status & Official Google Sign-In**: Shows authenticated Google account identity (`User Email`, active Drive scope verification) or the official Google Sign-In button.
   - **Configurable Copy Manifest**: Checkboxes allowing the user to include/exclude:
     - Full Application Source Tree (`server.ts`, `src/**`, `package.json`)
     - Live Quantitative Telemetry, Indicator Tournament & Comparative Backtest State
     - Kalshi 15m Execution Ledger & Public.com BTC Order Book
     - Master Quant Playbook Vault Document
   - **One-Click "Copy App to Google Drive"**:
     - Creates a dedicated folder in Google Drive (`application/vnd.google-apps.folder`) using `https://www.googleapis.com/drive/v3/files`.
     - Uploads each manifest artifact via multipart Drive v3 upload (`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`).
     - Displays deterministic progress steps, file sizes (`tabular-nums`), and direct `webViewLink` links to open the copied folder and files in Google Drive.
   - **Existing Drive Copies Manager & Restore**:
     - Queries the user's Google Drive for previously created `QuantPulse_Finesse_Finance` folders and snapshots.
     - Allows loading/restoring a saved state snapshot from Drive back into the running app.
     - Enforces a **Confirmation Modal** before overwriting an existing Drive snapshot or deleting an old backup copy.

---

## 4. Backend & Frontend File Changes
- **`/server.ts`**:
  - Add `GET /api/app-bundle/export`: Packages the live engine state, indicator scoreboard, active orders, and key project source files (`package.json`, `server.ts`, `src/App.tsx`, `src/types/quant.ts`, `src/components/**`) into a deterministic export payload with SHA-like integrity metadata and `dataQualityWarning` validation.
  - Add `POST /api/app-bundle/restore`: Validates and restores a state snapshot imported from Google Drive.
- **`/src/services/googleDriveService.ts`**:
  - Encapsulates Firebase Google Auth sign-in, in-memory OAuth access token management, Drive folder creation, multipart file uploads, existing copy listing, and Drive file download/deletion.
- **`/src/components/GoogleDriveCopyPanel.tsx`**:
  - Institutional dark-slate UI adhering to the `frontend-design` SaaS dashboard guidelines (tabular numerals, single-elevation cards, official "Sign in with Google" button, and mandatory confirmation dialog for destructive/overwrite actions).
- **`/src/App.tsx`**:
  - Integrate the **Google Drive App Copy** trigger in the workspace navigation and top bar so users can copy or sync their app to Google Drive from anywhere in the terminal.
