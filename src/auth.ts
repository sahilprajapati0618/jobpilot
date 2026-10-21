// User accounts and sessions for the web app.
// Passwords are hashed with scrypt; session tokens are random and only their SHA-256 hash is stored.

import path from "node:path";
import crypto from "node:crypto";
import { dataDir, readJsonFile, writeFileAtomic } from "./store.js";

export interface User {
  id: string;
  email: string;
  name: string;
  passwordHash?: string; // absent for Google-only accounts
  googleId?: string;
  picture?: string;
  createdAt: string;
}

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  picture?: string;
}

interface Session {
  userId: string;
  expiresAt: number;
}

export type AuthErrorCode =
  | "name_required"
  | "invalid_email"
  | "weak_password"
  | "email_taken"
  | "invalid_credentials"
  | "use_google";

export class AuthError extends Error {
  constructor(
    public code: AuthErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MIN_PASSWORD = 8;

const usersFile = () => path.join(dataDir(), "users.json");
const sessionsFile = () => path.join(dataDir(), "sessions.json");

// Serializes read-modify-write cycles on the auth files so concurrent requests can't lose updates.
let queue: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

const loadUsers = () => readJsonFile<User[]>(usersFile(), []);
const saveUsers = (users: User[]) => writeFileAtomic(usersFile(), JSON.stringify(users, null, 2));
const loadSessions = () => readJsonFile<Record<string, Session>>(sessionsFile(), {});
const saveSessions = (s: Record<string, Session>) => writeFileAtomic(sessionsFile(), JSON.stringify(s, null, 2));

export function toPublic(user: User): PublicUser {
  return { id: user.id, email: user.email, name: user.name, picture: user.picture };
}

// ---------- Passwords ----------

function scrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, 64, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scrypt(password, Buffer.from(salt, "base64"));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// Used when the email doesn't exist, so a failed login takes the same time either way.
let dummyHash: Promise<string> | undefined;

// ---------- Accounts ----------

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

export async function signup(input: { name: string; email: string; password: string }): Promise<User> {
  const name = input.name.trim();
  const email = normalizeEmail(input.email);
  if (!name) throw new AuthError("name_required", "Please enter your name");
  if (!validEmail(email)) throw new AuthError("invalid_email", "Please enter a valid email");
  if (input.password.length < MIN_PASSWORD) {
    throw new AuthError("weak_password", `Password must be at least ${MIN_PASSWORD} characters`);
  }
  const passwordHash = await hashPassword(input.password);

  return withLock(async () => {
    const users = await loadUsers();
    if (users.some((u) => u.email === email)) throw new AuthError("email_taken", "An account with this email already exists");
    const user: User = { id: crypto.randomUUID(), email, name: name.slice(0, 80), passwordHash, createdAt: new Date().toISOString() };
    users.push(user);
    await saveUsers(users);
    return user;
  });
}

export async function login(emailInput: string, password: string): Promise<User> {
  const email = normalizeEmail(emailInput);
  const user = (await loadUsers()).find((u) => u.email === email);
  if (!user?.passwordHash) {
    await verifyPassword(password, await (dummyHash ??= hashPassword("timing-equalizer")));
    if (user?.googleId) throw new AuthError("use_google", "This account uses Google sign-in");
    throw new AuthError("invalid_credentials", "Wrong email or password");
  }
  if (!(await verifyPassword(password, user.passwordHash))) {
    throw new AuthError("invalid_credentials", "Wrong email or password");
  }
  return user;
}

// Signs in with a verified Google profile: matches by Google ID, then links by email, else creates an account.
export async function findOrCreateGoogleUser(profile: {
  sub: string;
  email: string;
  name: string;
  picture?: string;
}): Promise<User> {
  return withLock(async () => {
    const users = await loadUsers();
    const email = normalizeEmail(profile.email);
    let user = users.find((u) => u.googleId === profile.sub) ?? users.find((u) => u.email === email);
    if (user) {
      user.googleId = profile.sub;
      user.picture = profile.picture ?? user.picture;
    } else {
      user = {
        id: crypto.randomUUID(),
        email,
        name: (profile.name || email.split("@")[0]).slice(0, 80),
        googleId: profile.sub,
        picture: profile.picture,
        createdAt: new Date().toISOString(),
      };
      users.push(user);
    }
    await saveUsers(users);
    return user;
  });
}

// ---------- Sessions ----------

const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

export async function createSession(userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url");
  await withLock(async () => {
    const sessions = await loadSessions();
    const now = Date.now();
    for (const [key, s] of Object.entries(sessions)) if (s.expiresAt < now) delete sessions[key];
    sessions[hashToken(token)] = { userId, expiresAt: now + SESSION_TTL_MS };
    await saveSessions(sessions);
  });
  return token;
}

export async function getSessionUser(token: string | undefined): Promise<User | undefined> {
  if (!token) return undefined;
  const session = (await loadSessions())[hashToken(token)];
  if (!session || session.expiresAt < Date.now()) return undefined;
  return (await loadUsers()).find((u) => u.id === session.userId);
}

export async function deleteSession(token: string | undefined): Promise<void> {
  if (!token) return;
  await withLock(async () => {
    const sessions = await loadSessions();
    delete sessions[hashToken(token)];
    await saveSessions(sessions);
  });
}
