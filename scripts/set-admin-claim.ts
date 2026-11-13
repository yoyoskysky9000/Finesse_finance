import { initializeApp, getApps, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface AppletFirebaseConfig {
  projectId?: string;
}

function resolveProjectId(): string | undefined {
  if (process.env.FIREBASE_PROJECT_ID) {
    return process.env.FIREBASE_PROJECT_ID;
  }
  try {
    const cfgPath = path.resolve(__dirname, '../firebase-applet-config.json');
    const raw = fs.readFileSync(cfgPath, 'utf8');
    const parsed = JSON.parse(raw) as AppletFirebaseConfig;
    return parsed.projectId;
  } catch {
    return undefined;
  }
}

interface ParsedCliArgs {
  uid: string | null;
  email: string | null;
  adminValue: boolean;
}

function parseCliArgs(argv: string[]): ParsedCliArgs {
  let uid: string | null = null;
  let email: string | null = null;
  let adminValue = true;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--uid' && argv[i + 1]) {
      uid = argv[++i] || null;
    } else if (arg === '--email' && argv[i + 1]) {
      email = argv[++i] || null;
    } else if (arg === '--revoke') {
      adminValue = false;
    }
  }

  return { uid, email, adminValue };
}

async function main(): Promise<void> {
  const { uid, email, adminValue } = parseCliArgs(process.argv.slice(2));

  if (!uid && !email) {
    console.error(
      'Usage: npm run set-admin-claim -- --uid <FIREBASE_UID> [--revoke]\n' +
        '   or: npm run set-admin-claim -- --email <USER_EMAIL> [--revoke]'
    );
    process.exit(1);
  }

  const projectId = resolveProjectId();
  if (getApps().length === 0) {
    initializeApp({
      credential: applicationDefault(),
      ...(projectId ? { projectId } : {}),
    });
  }

  const adminAuth = getAuth();
  const userRecord = uid
    ? await adminAuth.getUser(uid)
    : await adminAuth.getUserByEmail(email as string);

  const existingClaims = userRecord.customClaims ?? {};
  const nextClaims = {
    ...existingClaims,
    admin: adminValue,
  };

  await adminAuth.setCustomUserClaims(userRecord.uid, nextClaims);
  await adminAuth.revokeRefreshTokens(userRecord.uid);

  console.log(
    JSON.stringify(
      {
        ok: true,
        uid: userRecord.uid,
        email: userRecord.email ?? null,
        customClaims: nextClaims,
        note: 'Refresh tokens revoked; have the user call getIdToken(true) or sign in again.',
      },
      null,
      2
    )
  );
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Failed to set custom claim: ${message}`);
  process.exit(1);
});
