/** Row types and the account view shared by several endpoints. */
import type { Json } from './http';

export interface UserRow {
  id: string;
  name: string;
  created_at: number;
}

export interface CredentialRow {
  id: string;
  user_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  device_type: string;
  backed_up: number;
  aaguid: string | null;
  created_at: number;
  last_used_at: number | null;
}

export interface ProgressRow {
  state: string;
  version: number;
}

/** Best-guess password manager names for well-known AAGUIDs (community-maintained list; many send zeros). */
const PROVIDERS: Readonly<Record<string, string>> = {
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'iCloud Keychain',
  'dd4ec289-e01d-41c9-bb89-70fa845d4bf2': 'iCloud Keychain (managed)',
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google Password Manager',
  'adce0002-35bc-c60a-648b-0b25f1f05503': 'Chrome on Mac',
  '08987058-cadc-4b81-b6e1-30de50dcbe96': 'Windows Hello',
  '9ddd1817-af5a-4672-a2b9-3e3dd95000a9': 'Windows Hello',
  '6028b017-b1d4-4c02-b4b3-afcdafc96bb2': 'Windows Hello',
  '53414d53-554e-4700-0000-000000000000': 'Samsung Pass',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
  'd548826e-79b4-db40-a3d8-11116f7e8349': 'Bitwarden',
  '531126d6-e717-415c-9320-3d9aa6981239': 'Dashlane'
};

export function providerName(aaguid: string | null): string | null {
  return aaguid && Object.hasOwn(PROVIDERS, aaguid) ? PROVIDERS[aaguid]! : null;
}

export function accountView(user: UserRow, credentials: readonly CredentialRow[]): Json {
  return {
    userHandle: user.id,
    name: user.name,
    createdAt: user.created_at,
    passkeys: credentials.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      synced: row.backed_up === 1,
      provider: providerName(row.aaguid)
    }))
  };
}

export function selectUser(db: D1Database, userId: string): D1PreparedStatement {
  return db.prepare('SELECT id, name, created_at FROM users WHERE id = ?').bind(userId);
}

export function selectCredentials(db: D1Database, userId: string): D1PreparedStatement {
  return db.prepare('SELECT * FROM credentials WHERE user_id = ? ORDER BY created_at, id').bind(userId);
}

/** The user and their passkeys in one round trip. Null if the user no longer exists. */
export async function loadAccount(db: D1Database, userId: string): Promise<{ user: UserRow; credentials: CredentialRow[] } | null> {
  const [users, credentials] = await db.batch([selectUser(db, userId), selectCredentials(db, userId)]);
  const user = (users?.results as UserRow[] | undefined)?.[0];
  if (!user) return null;
  return { user, credentials: (credentials?.results ?? []) as CredentialRow[] };
}

export function parseTransports(text: string | null): string[] | undefined {
  if (!text) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
  } catch {
    return undefined;
  }
}

/** The constraint a UNIQUE / PRIMARY KEY failure names, e.g. 'used_challenges.challenge'. */
export function uniqueViolation(err: unknown): string | null {
  const message = err instanceof Error ? err.message : '';
  return /UNIQUE constraint failed: ([\w.]+)/.exec(message)?.[1] ?? null;
}
