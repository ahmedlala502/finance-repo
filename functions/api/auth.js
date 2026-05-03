const USERS_KEY = "trygc-auth-users-v1";
const ADMIN_EMAIL = "admin@trygc.com";
const ADMIN_PASSWORD = "admin123";

const DEFAULT_USERS = [];

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });

const cleanEmail = value => String(value || "").trim().toLowerCase();
const publicUser = ({ passwordHash, passwordSalt, ...user }) => user;
const uid = role => `${role || "user"}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

async function hashPassword(password, salt) {
  const input = new TextEncoder().encode(`${salt}:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function makeUser({ email, password, name, role, fixedUid }) {
  const salt = crypto.randomUUID();
  return {
    uid: fixedUid || uid(role),
    email: cleanEmail(email),
    displayName: String(name || "").trim(),
    role: role || "viewer",
    createdAt: Date.now(),
    passwordSalt: salt,
    passwordHash: await hashPassword(password, salt)
  };
}

async function readUsers(env) {
  if (!env.AUTH_USERS) throw new Error("AUTH_USERS binding is not configured");
  const raw = await env.AUTH_USERS.get(USERS_KEY);
  if (!raw) return [];
  const users = JSON.parse(raw);
  return Array.isArray(users) ? users : [];
}

async function writeUsers(env, users) {
  await env.AUTH_USERS.put(USERS_KEY, JSON.stringify(users));
}

async function ensureDefaultUsers(env) {
  let users = await readUsers(env);
  const demoEmails = new Set(["finance@trygc.com", "sales.manager@trygc.com", "rep@trygc.com", "analyst@trygc.com", "viewer@trygc.com"]);
  users = users.filter(user => !demoEmails.has(cleanEmail(user.email)));
  if (!users.some(user => cleanEmail(user.email) === ADMIN_EMAIL)) {
    users.unshift(await makeUser({
      fixedUid: "remote-admin",
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      name: "Admin User",
      role: "admin"
    }));
  }
  for (const user of DEFAULT_USERS) {
    if (!users.some(existing => cleanEmail(existing.email) === cleanEmail(user.email))) {
      users.push(await makeUser(user));
    }
  }
  await writeUsers(env, users);
  return users;
}

function requireActor(users, actorUid, allowSelfUid) {
  const actor = users.find(user => user.uid === actorUid);
  if (!actor) throw new Error("Not authenticated.");
  if (actor.role === "admin" || actor.uid === allowSelfUid) return actor;
  throw new Error("Admin access required.");
}

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const action = body.action;

    if (action === "ensureDefaultUser") {
      await ensureDefaultUsers(env);
      return json({ ok: true });
    }

    let users = await ensureDefaultUsers(env);

    if (action === "signIn") {
      const email = cleanEmail(body.email);
      const user = users.find(candidate => cleanEmail(candidate.email) === email);
      if (!user) return json({ error: "No user found for that email." }, 401);
      const hash = await hashPassword(body.password || "", user.passwordSalt);
      if (hash !== user.passwordHash) return json({ error: "Incorrect password." }, 401);
      return json({ user: publicUser(user) });
    }

    if (action === "listUsers") {
      requireActor(users, body.actorUid);
      return json({ users: users.map(publicUser) });
    }

    if (action === "createUser") {
      requireActor(users, body.actorUid);
      const email = cleanEmail(body.email);
      if (!email || !body.password || !body.name) return json({ error: "Name, email, and password are required." }, 400);
      if (users.some(user => cleanEmail(user.email) === email)) return json({ error: "A user with this email already exists." }, 409);
      const user = await makeUser({ email, password: body.password, name: body.name, role: body.role });
      users.push(user);
      await writeUsers(env, users);
      return json({ user: publicUser(user) });
    }

    if (action === "removeUser") {
      requireActor(users, body.actorUid);
      const email = cleanEmail(body.email);
      users = users.filter(user => cleanEmail(user.email) !== email);
      await writeUsers(env, users);
      return json({ users: users.map(publicUser) });
    }

    if (action === "updateUser") {
      const index = users.findIndex(user => user.uid === body.uid);
      if (index < 0) return json({ error: "User not found." }, 404);
      const actor = requireActor(users, body.actorUid, body.uid);
      const updates = body.updates || {};
      const allowed = actor.role === "admin"
        ? updates
        : { displayName: updates.displayName, email: updates.email };
      users[index] = { ...users[index], ...allowed, uid: users[index].uid };
      await writeUsers(env, users);
      return json({ user: publicUser(users[index]) });
    }

    if (action === "changePassword") {
      const index = users.findIndex(user => user.uid === body.uid);
      if (index < 0) return json({ error: "User not found." }, 404);
      requireActor(users, body.actorUid, body.uid);
      const salt = crypto.randomUUID();
      users[index] = { ...users[index], passwordSalt: salt, passwordHash: await hashPassword(body.password || "", salt) };
      await writeUsers(env, users);
      return json({ ok: true });
    }

    if (action === "updateEmail") {
      const index = users.findIndex(user => user.uid === body.uid);
      if (index < 0) return json({ error: "User not found." }, 404);
      requireActor(users, body.actorUid, body.uid);
      const email = cleanEmail(body.email);
      if (users.some(user => cleanEmail(user.email) === email && user.uid !== body.uid)) {
        return json({ error: "Email already in use." }, 409);
      }
      users[index] = { ...users[index], email };
      await writeUsers(env, users);
      return json({ user: publicUser(users[index]) });
    }

    return json({ error: "Unsupported auth action." }, 400);
  } catch (error) {
    return json({ error: error.message || "Authentication request failed." }, 500);
  }
}
