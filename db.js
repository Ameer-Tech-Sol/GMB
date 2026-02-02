import pkg from "pg";
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export async function addCoins(whatsappNumber, amount) {
  const result = await pool.query(
    `
    UPDATE users
    SET coins = coins + $1,
        last_active = NOW()
    WHERE whatsapp_number = $2
    RETURNING coins
    `,
    [amount, whatsappNumber]
  );

  if (result.rows.length === 0) {
    throw new Error("User not registered");
  }

  return result.rows[0].coins;
}

export async function getBalance(whatsappNumber) {
  const result = await pool.query(
    `SELECT coins FROM users WHERE whatsapp_number = $1`,
    [whatsappNumber]
  );

  if (result.rows.length === 0) {
    throw new Error("User not registered");
  }

  return result.rows[0].coins;
}
