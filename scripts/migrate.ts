import { migrate, pool } from '../app/server/db.server';

try {
  await migrate();
} finally {
  await pool.end();
}
