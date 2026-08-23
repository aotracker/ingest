/**
 * Promote a website user to admin by Discord snowflake, Google subject, or email.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/promote-admin.ts --discord-id 1234567890
 *   npx tsx --env-file=.env scripts/promote-admin.ts --google-sub 118234567890
 *   npx tsx --env-file=.env scripts/promote-admin.ts --email user@gmail.com
 */
import postgres from "postgres";

function argValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return null;
  return process.argv[idx + 1] ?? null;
}

async function main() {
  const discordId = argValue("--discord-id");
  const googleSub = argValue("--google-sub");
  const email = argValue("--email");

  if (!discordId && !googleSub && !email) {
    console.error(
      "Usage: promote-admin.ts --discord-id <snowflake> | --google-sub <sub> | --email <email>"
    );
    process.exit(1);
  }

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const sql = postgres(url, { max: 1 });
  try {
    let rows: { id: string; name: string; email: string }[] = [];

    if (discordId) {
      rows = await sql<{ id: string; name: string; email: string }[]>`
        SELECT u.id, u.name, u.email
        FROM "user" u
        INNER JOIN "account" a ON a.user_id = u.id
        WHERE a.provider_id = 'discord' AND a.account_id = ${discordId}
        LIMIT 1
      `;
      if (rows.length === 0) {
        console.error(
          `No user found for Discord id ${discordId}. Sign in once with Discord first.`
        );
        process.exit(1);
      }
    } else if (googleSub) {
      rows = await sql<{ id: string; name: string; email: string }[]>`
        SELECT u.id, u.name, u.email
        FROM "user" u
        INNER JOIN "account" a ON a.user_id = u.id
        WHERE a.provider_id = 'google' AND a.account_id = ${googleSub}
        LIMIT 1
      `;
      if (rows.length === 0) {
        console.error(
          `No user found for Google sub ${googleSub}. Sign in once with Google first.`
        );
        process.exit(1);
      }
    } else if (email) {
      const normalized = email.trim().toLowerCase();
      rows = await sql<{ id: string; name: string; email: string }[]>`
        SELECT u.id, u.name, u.email
        FROM "user" u
        WHERE lower(u.email) = ${normalized}
        LIMIT 1
      `;
      if (rows.length === 0) {
        console.error(
          `No user found for email ${email}. Sign in once first.`
        );
        process.exit(1);
      }
    }

    const user = rows[0]!;
    await sql`
      UPDATE "user" SET is_admin = true, updated_at = now() WHERE id = ${user.id}
    `;
    console.log(`Promoted ${user.name} (${user.email}) [${user.id}] to admin.`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
