const mysql = require('mysql2/promise');

const missing = ['DB_HOST', 'DB_USER', 'DB_NAME'].filter(k => !process.env[k]);
if (missing.length) console.error(`⚠️  Variabel belum terbaca: ${missing.join(', ')} (cek Environment Variables)`);

const pool = mysql.createPool({
  host: process.env.DB_HOST, port: +process.env.DB_PORT || 3306,
  user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  waitForConnections: true, connectionLimit: 10,
  timezone: 'Z',            // simpan & baca DATETIME sebagai UTC
  dateStrings: ['DATE', 'TIME'] // DATE/TIME tetap string; DATETIME jadi objek Date (UTC)
});

// Tes koneksi saat server start
(async () => {
  const target = `${process.env.DB_HOST}:${+process.env.DB_PORT || 3306}/${process.env.DB_NAME}`;
  try {
    const conn = await pool.getConnection();
    await conn.ping();
    conn.release();
    console.log(`✅ Database terhubung: ${target}`);
  } catch (e) {
    console.error(`❌ Database GAGAL terhubung: ${target}`);
    console.error(`   ${e.code || 'ERROR'}: ${e.message}`);
  }
})();

module.exports = pool;