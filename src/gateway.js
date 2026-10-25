/**
 * Adapter payment gateway. Hanya file ini yang perlu disesuaikan dengan gateway Anda
 * (LinkQu / lainnya). Kontrak internal yang dipakai router:
 *
 *   createPayment({orderId, amount, method, bank, customer}) ->
 *     { partnerRef, vaNumber?, qrString?, qrImageUrl?, expiredAt: Date, raw }
 *   verifyCallback(req) -> boolean      (req.rawBody = body mentah)
 *   parseCallback(body) -> { partnerRef, status: 'PAID'|'FAILED'|'EXPIRED', amount, raw }
 */
const crypto = require('crypto');
const LIVE = process.env.GATEWAY_MODE === 'live';
const cfg = {
  baseUrl: process.env.GATEWAY_BASE_URL, clientId: process.env.GATEWAY_CLIENT_ID,
  clientSecret: process.env.GATEWAY_CLIENT_SECRET, username: process.env.GATEWAY_USERNAME,
  pin: process.env.GATEWAY_PIN, serverKey: process.env.GATEWAY_SERVER_KEY
};
const TTL = (+process.env.PAYMENT_TTL_MINUTES || 15) * 60000;

async function createPayment({ orderId, amount, method, bank, customer }) {
  const expiredAt = new Date(Date.now() + TTL);
  if (!LIVE) { // ---- MOCK ----
    return {
      partnerRef: 'MOCK-' + orderId + '-' + Date.now().toString(36),
      vaNumber: method === 'VA' ? '8808' + String(Math.floor(Math.random() * 1e12)).padStart(12, '0') : undefined,
      qrString: method === 'QRIS' ? 'MOCK-QRIS-' + orderId : undefined,
      expiredAt, raw: { mock: true }
    };
  }
  // ---- LIVE: ISI SESUAI DOKUMENTASI LINKQU ----
  // Kredensial tersedia di `cfg` (baseUrl, clientId, clientSecret, username, pin, serverKey).
  // Path endpoint, field body, dan rumus signature mengikuti dokumentasi LinkQu / kode proyek catur.
  // Contoh kerangka (endpoint, header, nama field di bawah HANYA placeholder):
  //
  // const body = { partner_reff: orderId, amount, customer_name: customer.name,
  //                expired: expiredAt.toISOString(), bank_code: bank };
  // const res = await fetch(cfg.baseUrl + (method === 'QRIS' ? '/qris' : '/va'), {
  //   method: 'POST',
  //   headers: { 'Content-Type': 'application/json',
  //              'client-id': cfg.clientId,
  //              'client-secret': cfg.clientSecret },
  //   body: JSON.stringify(body)
  // });
  // const j = await res.json();
  // if (!res.ok) throw new Error('Gateway: ' + (j.message || res.status));
  // return { partnerRef: j.partner_reff || orderId, vaNumber: j.virtual_account,
  //          qrString: j.qris_string, qrImageUrl: j.qris_image, expiredAt, raw: j };
  throw new Error('GATEWAY_MODE=live tetapi createPayment() belum diimplementasikan');
}

function verifyCallback(req) {
  if (!LIVE) return true;
  const secret = process.env.GATEWAY_WEBHOOK_SECRET;
  const sig = String(req.get('x-signature') || ''); // sesuaikan nama header & algoritma dengan gateway
  if (!secret || !sig || !req.rawBody) return false;
  const exp = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  const a = Buffer.from(exp), b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseCallback(body) {
  // Sesuaikan pemetaan field dengan payload callback gateway.
  const s = String(body.status || '').toUpperCase();
  const status = ['PAID', 'SUCCESS', 'SETTLED'].includes(s) ? 'PAID'
               : ['EXPIRED'].includes(s) ? 'EXPIRED' : ['FAILED', 'CANCELLED'].includes(s) ? 'FAILED' : null;
  return { partnerRef: body.partner_ref || body.partnerRef, status, amount: body.amount, raw: body };
}

module.exports = { createPayment, verifyCallback, parseCallback, LIVE };
