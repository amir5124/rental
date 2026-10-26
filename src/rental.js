const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const pool = require('./db');
const gw = require('./gateway');
const { sendWhatsApp } = require('./notify');

const r = express.Router();
const BANKS = ['BCA', 'BNI', 'BRI', 'MANDIRI'];
const MAX_DAYS = 30;
const wita = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); // tanggal hari ini (WITA)
const genId = () => 'RM-' + new Date().toISOString().slice(2, 10).replace(/-/g, '') + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
const clean = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

// "2026-10-27" + 3 hari -> tanggal terakhir sewa "2026-10-29"
const endDate = (iso, days) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days - 1); return d.toISOString().slice(0, 10); };
const fmtDate = iso => String(iso).split('-').reverse().join('/');

function validate(b) {
  const o = {
    name: clean(b.customer_name, 100), wa: String(b.whatsapp ?? '').replace(/[\s\-+]/g, ''),
    car: clean(b.car_code, 30), date: clean(b.date, 10), time: clean(b.time, 5),
    days: parseInt(b.days, 10) || 1,
    pax: parseInt(b.passengers, 10), pickup: clean(b.pickup, 200), dest: clean(b.destination, 200),
    notes: clean(b.notes, 300), method: b.payment_method, bank: b.bank ? String(b.bank).toUpperCase() : null
  };
  if (o.name.length < 3) return { error: 'Nama tidak valid' };
  if (!/^628\d{8,12}$/.test(o.wa)) return { error: 'Nomor WhatsApp tidak valid' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.date) || o.date < wita()) return { error: 'Tanggal pemakaian tidak valid' };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(o.time)) return { error: 'Jam penjemputan tidak valid' };
  if (!(o.days >= 1 && o.days <= MAX_DAYS)) return { error: `Lama sewa 1-${MAX_DAYS} hari` };
  if (!(o.pax >= 1 && o.pax <= 8)) return { error: 'Jumlah penumpang 1-8' };
  if (!o.pickup || !o.dest) return { error: 'Lokasi & tujuan wajib diisi' };
  if (!['QRIS', 'VA'].includes(o.method)) return { error: 'Metode pembayaran tidak valid' };
  if (o.method === 'VA' && !BANKS.includes(o.bank)) return { error: 'Bank tidak didukung' };
  if (o.method === 'QRIS') o.bank = null;
  return { v: o };
}

// ---- Buat order + minta QRIS / VA ----
r.post('/order', rateLimit({ windowMs: 60000, max: 10, standardHeaders: true, legacyHeaders: false }), async (req, res) => {
  const { v, error } = validate(req.body || {});
  if (error) return res.status(400).json({ success: false, message: error });
  try {
    const [[car]] = await pool.query('SELECT code, name, price_12h, service FROM rental_cars WHERE code=? AND active=1', [v.car]);
    if (!car) return res.status(400).json({ success: false, message: 'Mobil tidak tersedia' });

    // Harga SELALU dari DB: harga per hari x lama sewa. (kolom price_12h = harga per hari)
    const orderId = genId(), amount = Number(car.price_12h) * v.days;
    await pool.query(
      `INSERT INTO rental_orders (order_id, customer_name, whatsapp, car_code, car_name, service, usage_date, pickup_time, days,
        passengers, pickup_location, destination, notes, total_amount, payment_method, bank)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [orderId, v.name, v.wa, car.code, car.name, car.service, v.date, v.time, v.days, v.pax, v.pickup, v.dest, v.notes || null, amount, v.method, v.bank]);

    let p;
    try {
      p = await gw.createPayment({ orderId, amount, method: v.method, bank: v.bank, customer: { name: v.name, wa: v.wa } });
    } catch (e) {
      await pool.query("UPDATE rental_orders SET status='FAILED' WHERE order_id=?", [orderId]);
      console.error('[gateway]', e.message);
      return res.status(502).json({ success: false, message: 'Gagal membuat pembayaran, coba lagi' });
    }
    await pool.query(
      `INSERT INTO rental_payments (order_id, partner_ref, method, bank, va_number, qr_string, qr_image_url, amount, expired_at, gateway_response)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [orderId, p.partnerRef, v.method, v.bank, p.vaNumber || null, p.qrString || null, p.qrImageUrl || null, amount, p.expiredAt, JSON.stringify(p.raw || {})]);

    res.json({
      success: true, data: {
        order_id: orderId, total: amount, days: v.days, service: car.service, expired_at: p.expiredAt.toISOString(),
        bank: v.bank, va_number: p.vaNumber, qr_string: p.qrString, qr_image_url: p.qrImageUrl
      }
    });
  } catch (e) {
    console.error(e); res.status(500).json({ success: false, message: 'Terjadi kesalahan server' });
  }
});

// ---- Polling status dari frontend ----
r.get('/status/:orderId', async (req, res) => {
  try {
    const [[o]] = await pool.query('SELECT order_id, status FROM rental_orders WHERE order_id=?', [req.params.orderId]);
    if (!o) return res.status(404).json({ success: false, message: 'Order tidak ditemukan' });
    let status = o.status;
    if (status === 'PENDING') {
      const [[p]] = await pool.query('SELECT MAX(expired_at) AS exp FROM rental_payments WHERE order_id=?', [o.order_id]);
      if (p && p.exp && new Date(p.exp) < new Date()) status = 'EXPIRED'; // update DB dikerjakan job expiry
    }
    res.json({ success: true, data: { status } });
  } catch (e) { console.error(e); res.status(500).json({ success: false }); }
});

// ---- Tandai lunas (idempotent): dipakai callback & simulasi ----
async function markPaid(partnerRef, amount, logResult) {
  const [[p]] = await pool.query('SELECT order_id, amount, status FROM rental_payments WHERE partner_ref=?', [partnerRef]);
  if (!p) return logResult('unknown_ref', 404);
  if (amount != null && Number(amount) !== Number(p.amount)) return logResult('amount_mismatch', 400);
  const [u] = await pool.query("UPDATE rental_payments SET status='PAID', paid_at=UTC_TIMESTAMP() WHERE partner_ref=? AND status<>'PAID'", [partnerRef]);
  if (!u.affectedRows) return logResult('duplicate', 200);
  // Pembayaran yang masuk setelah EXPIRED tetap diterima (uang sudah masuk).
  await pool.query("UPDATE rental_orders SET status='PAID', paid_at=UTC_TIMESTAMP() WHERE order_id=? AND status<>'PAID'", [p.order_id]);
  notifyPaid(p.order_id).catch(e => console.error('[notify]', e.message));
  return logResult('ok', 200);
}

// ---- Notifikasi WhatsApp: template pelanggan & admin (urutan variabel = urutan {{n}} di template Twilio) ----
// Template tidak diubah: jenis layanan dimasukkan ke variabel "mobil", lama sewa ke variabel "jadwal".
async function notifyPaid(orderId) {
  const [[o]] = await pool.query('SELECT * FROM rental_orders WHERE order_id=?', [orderId]);
  if (!o) return;
  const days = Number(o.days) || 1;
  const tgl = fmtDate(o.usage_date), jam = o.pickup_time.slice(0, 5);
  const total = 'Rp ' + Number(o.total_amount).toLocaleString('id-ID');
  const jadwal = days > 1 ? `${tgl} ${jam} s/d ${fmtDate(endDate(o.usage_date, days))} (${days} hari)` : `${tgl} ${jam} (1 hari)`;
  const mobil = `${o.car_name} (${o.service === 'SELF' ? 'Tanpa Driver' : 'Dengan Driver'})`;

  // Template pelanggan: {{1}} nama, {{2}} no. pesanan, {{3}} mobil, {{4}} jadwal, {{5}} jemput, {{6}} tujuan, {{7}} total
  const customerVars = { 1: o.customer_name, 2: o.order_id, 3: mobil, 4: jadwal, 5: o.pickup_location, 6: o.destination, 7: total };
  // Template admin: {{1}} no. pesanan, {{2}} nama, {{3}} WA, {{4}} mobil, {{5}} jadwal, {{6}} jemput, {{7}} tujuan, {{8}} penumpang, {{9}} catatan, {{10}} total
  const adminVars = { 1: o.order_id, 2: o.customer_name, 3: o.whatsapp, 4: mobil, 5: jadwal, 6: o.pickup_location, 7: o.destination, 8: o.passengers, 9: o.notes, 10: total };

  // Cadangan teks biasa bila SID template tidak diisi
  const body = `Pembayaran berhasil ✅\nNo. Pesanan: ${o.order_id}\nNama: ${o.customer_name}\nMobil: ${mobil}\nJadwal: ${jadwal}\nJemput: ${o.pickup_location}\nTujuan: ${o.destination}\nTotal: ${total}\n\nTerima kasih, LinkU.`;

  const admins = (process.env.ADMIN_WA || '6281347423737').split(',').map(x => x.trim()).filter(Boolean);
  const jobs = [
    { to: o.whatsapp, vars: customerVars, role: 'customer' },
    ...admins.map(to => ({ to, vars: adminVars, role: 'admin' }))
  ];
  const rs = await Promise.allSettled(jobs.map(j => sendWhatsApp(j.to, { vars: j.vars, body, role: j.role })));
  rs.forEach((x, i) => {
    if (x.status === 'rejected') console.error('[wa] gagal kirim ke ...' + String(jobs[i].to).slice(-4) + ' (' + jobs[i].role + '):', x.reason.message);
  });
}

// ---- Callback dari payment gateway ----
r.post('/callback', async (req, res) => {
  const log = (partnerRef, verified, result, payload) =>
    pool.query('INSERT INTO rental_webhook_logs (partner_ref, verified, result, payload) VALUES (?,?,?,?)',
      [partnerRef || null, verified ? 1 : 0, result, JSON.stringify(payload || {})]).catch(() => { });
  try {
    if (!gw.verifyCallback(req)) { await log(null, false, 'bad_signature', req.body); return res.status(401).json({ success: false }); }
    const ev = gw.parseCallback(req.body || {});
    if (!ev.partnerRef || !ev.status) { await log(ev.partnerRef, true, 'unknown_ref', req.body); return res.status(400).json({ success: false }); }
    if (ev.status === 'PAID') {
      return await markPaid(ev.partnerRef, ev.amount, async (result, code) => {
        await log(ev.partnerRef, true, result, req.body);
        res.status(code).json({ success: code === 200 });
      });
    }
    await pool.query('UPDATE rental_payments SET status=? WHERE partner_ref=? AND status="PENDING"', [ev.status, ev.partnerRef]);
    await log(ev.partnerRef, true, 'ok', req.body);
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ success: false }); }
});

// ---- Simulasi bayar (HANYA saat GATEWAY_MODE=mock) ----
if (!gw.LIVE) {
  r.post('/mock/pay/:orderId', async (req, res) => {
    const [[p]] = await pool.query('SELECT partner_ref, amount FROM rental_payments WHERE order_id=? ORDER BY id DESC LIMIT 1', [req.params.orderId]);
    if (!p) return res.status(404).json({ success: false });
    await markPaid(p.partner_ref, p.amount, async (result, code) => res.status(code).json({ success: code === 200, result }));
  });
}

// ---- Job: tandai order kedaluwarsa tiap menit ----
function startExpiryJob() {
  setInterval(async () => {
    try {
      await pool.query("UPDATE rental_payments SET status='EXPIRED' WHERE status='PENDING' AND expired_at < UTC_TIMESTAMP()");
      await pool.query(`UPDATE rental_orders o SET o.status='EXPIRED' WHERE o.status='PENDING'
        AND NOT EXISTS (SELECT 1 FROM rental_payments p WHERE p.order_id=o.order_id AND p.status='PENDING')
        AND EXISTS (SELECT 1 FROM rental_payments p WHERE p.order_id=o.order_id)`);
    } catch (e) { console.error('[expiry]', e.message); }
  }, 60000).unref();
}

module.exports = { router: r, startExpiryJob };