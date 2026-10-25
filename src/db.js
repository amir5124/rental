const mysql = require('mysql2/promise');
module.exports = mysql.createPool({
  host: process.env.DB_HOST, port: +process.env.DB_PORT || 3306,
  user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  waitForConnections: true, connectionLimit: 10,
  timezone: 'Z',            // simpan & baca DATETIME sebagai UTC
  dateStrings: ['DATE','TIME'] // DATE/TIME tetap string; DATETIME jadi objek Date (UTC)
});
