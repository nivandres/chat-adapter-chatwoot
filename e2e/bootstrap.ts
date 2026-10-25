import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";

/**
 * Starts a disposable Chatwoot in Docker and writes `.env.e2e` for
 * `bun run test:e2e`. Run again to reuse it; `docker compose -f
 * e2e/docker-compose.yml down -v` throws it away.
 */
const dir = import.meta.dirname;
const root = join(dir, "..");
const port = process.env.CHATWOOT_PORT ?? "3300";
const url = `http://127.0.0.1:${port}`;
const compose = (...args: string[]) =>
  execFileSync(
    "docker",
    ["compose", "-f", join(dir, "docker-compose.yml"), ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );

if (!existsSync(join(dir, ".env")))
  writeFileSync(
    join(dir, ".env"),
    [
      `SECRET_KEY_BASE=${crypto.randomBytes(64).toString("hex")}`,
      `POSTGRES_PASSWORD=${crypto.randomBytes(16).toString("hex")}`,
      "POSTGRES_HOST=postgres",
      "POSTGRES_USERNAME=postgres",
      "POSTGRES_DATABASE=chatwoot",
      "REDIS_URL=redis://redis:6379",
      `FRONTEND_URL=${url}`,
      "RAILS_ENV=production",
      "NODE_ENV=production",
      "INSTALLATION_ENV=docker",
      "ACTIVE_STORAGE_SERVICE=local",
      "RAILS_LOG_TO_STDOUT=true",
      "ENABLE_ACCOUNT_SIGNUP=false",
      "ENABLE_PUSH_RELAY_SERVER=false",
      // Webhooks reach the test's own server on the host.
      "SAFE_FETCH_ALLOW_PRIVATE_NETWORK=true",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

compose("up", "-d", "postgres", "redis");
compose(
  "run",
  "--rm",
  "rails",
  "bundle",
  "exec",
  "rails",
  "db:chatwoot_prepare",
);
compose("up", "-d", "rails", "sidekiq");

for (let attempt = 0; ; attempt++) {
  const up = await fetch(`${url}/api`).then(
    (response) => response.ok,
    () => false,
  );
  if (up) break;
  if (attempt > 120) throw new Error(`Chatwoot never answered at ${url}`);
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

const password = `E2e-${crypto.randomBytes(12).toString("hex")}!`;
const seeded = compose(
  "exec",
  "-T",
  "-e",
  `PW=${password}`,
  "rails",
  "bundle",
  "exec",
  "rails",
  "runner",
  `
  account = Account.find_or_create_by!(name: "E2E")
  agents = [["Grace Hopper", "grace@e2e.test", :administrator], ["Alan Turing", "alan@e2e.test", :agent]].map do |name, email, role|
    user = User.find_by(email: email) || User.new(name: name, email: email, password: ENV["PW"], password_confirmation: ENV["PW"]).tap { |u| u.skip_confirmation!; u.save! }
    AccountUser.find_or_create_by!(account: account, user: user) { |member| member.role = role }
    user
  end
  puts({ account: account.id, admin: agents[0].access_token.token, agent: agents[1].access_token.token, agent_id: agents[1].id }.to_json)
  `,
)
  .trim()
  .split("\n")
  .at(-1)!;
const { account, admin, agent, agent_id } = JSON.parse(seeded);

// Chatwoot runs in a container, so it reaches the test's webhook server through the Docker host.
const hookHost =
  compose(
    "exec",
    "-T",
    "rails",
    "getent",
    "ahostsv4",
    "host.docker.internal",
  ).split(/\s+/)[0] ||
  Object.values(networkInterfaces())
    .flat()
    .find((address) => address?.family === "IPv4" && !address.internal)
    ?.address;

writeFileSync(
  join(root, ".env.e2e"),
  [
    `CHATWOOT_E2E_URL=${url}`,
    `CHATWOOT_E2E_ACCOUNT_ID=${account}`,
    `CHATWOOT_E2E_ADMIN_TOKEN=${admin}`,
    `CHATWOOT_E2E_AGENT_TOKEN=${agent}`,
    `CHATWOOT_E2E_AGENT_ID=${agent_id}`,
    `CHATWOOT_E2E_HOOK_HOST=${hookHost}`,
    "",
  ].join("\n"),
  { mode: 0o600 },
);
console.log(`Chatwoot ready at ${url}; wrote .env.e2e`);
