/**
 * API admin: pantau transaksi rental. Semua endpoint WAJIB token (env ADMIN_TOKEN).
 * Kirim lewat header:  Authorization: Bearer <ADMIN_TOKEN>   (atau  x-admin-token: <ADMIN_TOKEN>)
 *
 *   GET /api/rental/admin/summary              ringkasan angka + 20 jadwal pemakaian terdekat (sudah lunas)
 *   GET /api/rental/admin/orders               daftar order (filter: status, q, from, to, limit, offset)
 *   GET /api/rental/admin/orders/:orderId      detail order + pembayaran + log callback
 */
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const pool = require('./db');

const r = express.Router();
const STATUSES = ['PENDING', 'PAID', 'EXPIRED', 'FAILED'];

r.use(rateLimit({ windowMs: 60000, max: 120, standardHeaders: true, legacyHeaders: false }));

// ---- Autentikasi token (perbandingan aman waktu) ----
const digest = s => crypto.createHash('sha256').update(String(s)).digest();
// Default: TERBUKA (tanpa token). Pengaman opsional lewat env:
//   ADMIN_ALLOW_IPS=1.2.3.4,5.6.7.8   hanya IP ini yang boleh akses (tanpa token)
//   ADMIN_TOKEN=...                   bila diisi, token wajib (Authorization: Bearer ...)
r.use((req, res, next) => {
    const allow = (process.env.ADMIN_ALLOW_IPS || '').split(',').map(s => s.trim()).filter(Boolean);
    const ip = String(req.ip || '').replace(/^::ffff:/, '');
    if (allow.length && !allow.includes(ip)) return res.status(403).json({ success: false, message: 'IP tidak diizinkan' });

    const token = process.env.ADMIN_TOKEN;
    if (token) {
        const h = req.get('authorization') || '';
        const given = h.startsWith('Bearer ') ? h.slice(7).trim() : String(req.get('x-admin-token') || '');
        if (!given || !crypto.timingSafeEqual(digest(given), digest(token)))
            return res.status(401).json({ success: false, message: 'Token salah' });
    }
    res.set('Cache-Control', 'no-store');
    next();
});

const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const TODAY_WIB = "DATE(DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 HOUR))";

// ---- Ringkasan ----
r.get('/summary', async (_req, res) => {
    try {
        const [byStatus] = await pool.query('SELECT status, COUNT(*) AS n, COALESCE(SUM(total_amount),0) AS total FROM rental_orders GROUP BY status');
        const [[today]] = await pool.query(
            `SELECT COUNT(*) AS n, COALESCE(SUM(total_amount),0) AS total FROM rental_orders
       WHERE status='PAID' AND DATE(DATE_ADD(paid_at, INTERVAL 7 HOUR)) = ${TODAY_WIB}`);
        const [upcoming] = await pool.query(
            `SELECT order_id, customer_name, whatsapp, car_name, usage_date, pickup_time, passengers, pickup_location, destination, notes
       FROM rental_orders WHERE status='PAID' AND usage_date >= ${TODAY_WIB}
       ORDER BY usage_date ASC, pickup_time ASC LIMIT 20`);
        const stat = Object.fromEntries(STATUSES.map(s => [s, { n: 0, total: 0 }]));
        byStatus.forEach(x => { if (stat[x.status]) stat[x.status] = { n: Number(x.n), total: Number(x.total) }; });
        res.json({ success: true, data: { by_status: stat, paid_today: { n: Number(today.n), total: Number(today.total) }, upcoming } });
    } catch (e) { console.error('[admin]', e.message); res.status(500).json({ success: false, message: 'Terjadi kesalahan server' }); }
});

// ---- Daftar order ----
r.get('/orders', async (req, res) => {
    try {
        const where = [], args = [];
        const status = String(req.query.status || '').toUpperCase();
        if (STATUSES.includes(status)) { where.push('o.status=?'); args.push(status); }
        if (isDate(req.query.from)) { where.push('o.usage_date>=?'); args.push(req.query.from); }
        if (isDate(req.query.to)) { where.push('o.usage_date<=?'); args.push(req.query.to); }
        const q = String(req.query.q || '').trim().slice(0, 60);
        if (q) {
            const like = '%' + q.replace(/[\\%_]/g, c => '\\' + c) + '%';
            where.push('(o.order_id LIKE ? OR o.customer_name LIKE ? OR o.whatsapp LIKE ? OR o.car_name LIKE ?)');
            args.push(like, like, like, like);
        }
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        const w = where.length ? 'WHERE ' + where.join(' AND ') : '';

        const [[c]] = await pool.query(`SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN o.status='PAID' THEN o.total_amount END),0) AS paid_total FROM rental_orders o ${w}`, args);
        // order_id berawalan tanggal (RM-YYMMDD-...), jadi urut DESC = terbaru dulu
        const [rows] = await pool.query(
            `SELECT o.order_id, o.customer_name, o.whatsapp, o.car_code, o.car_name, o.usage_date, o.pickup_time, o.passengers,
              o.pickup_location, o.destination, o.notes, o.total_amount, o.payment_method, o.bank, o.status, o.paid_at
       FROM rental_orders o ${w} ORDER BY o.order_id DESC LIMIT ? OFFSET ?`, [...args, limit, offset]);
        res.json({ success: true, data: { total: Number(c.n), paid_total: Number(c.paid_total), limit, offset, rows } });
    } catch (e) { console.error('[admin]', e.message); res.status(500).json({ success: false, message: 'Terjadi kesalahan server' }); }
});

// ---- Detail order ----
r.get('/orders/:orderId', async (req, res) => {
    try {
        const [[order]] = await pool.query('SELECT * FROM rental_orders WHERE order_id=?', [req.params.orderId]);
        if (!order) return res.status(404).json({ success: false, message: 'Order tidak ditemukan' });
        const [payments] = await pool.query(
            'SELECT partner_ref, method, bank, va_number, amount, status, expired_at, paid_at FROM rental_payments WHERE order_id=? ORDER BY id DESC', [order.order_id]);
        let webhooks = [];
        if (payments.length) {
            [webhooks] = await pool.query('SELECT partner_ref, verified, result, payload FROM rental_webhook_logs WHERE partner_ref IN (?)', [payments.map(p => p.partner_ref)]);
        }
        res.json({ success: true, data: { order, payments, webhooks } });
    } catch (e) { console.error('[admin]', e.message); res.status(500).json({ success: false, message: 'Terjadi kesalahan server' }); }
});

module.exports = { router: r };