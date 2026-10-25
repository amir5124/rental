/**
 * Adapter payment gateway LinkQu (disalin dari pola backend Turnamen Catur).
 * Kontrak internal yang dipakai router:
 *
 *   createPayment({orderId, amount, method, bank, customer}) ->
 *     { partnerRef, vaNumber?, qrString?, qrImageUrl?, expiredAt: Date, raw }
 *   verifyCallback(req) -> boolean
 *   parseCallback(body) -> { partnerRef, status: 'PAID'|'FAILED'|'EXPIRED', amount, raw }
 *
 * ENV (Coolify):
 *   GATEWAY_MODE=live
 *   GATEWAY_BASE_URL=https://api.linkqu.id          (tanpa path)
 *   GATEWAY_CLIENT_ID, GATEWAY_CLIENT_SECRET, GATEWAY_USERNAME, GATEWAY_PIN, GATEWAY_SERVER_KEY
 *   GATEWAY_CALLBACK_URL=https://rental.siappgo.id/api/rental/callback   (opsional, ini defaultnya)
 *   GATEWAY_CUSTOMER_EMAIL=email@anda.com           (LinkQu mewajibkan email di signature)
 *   GATEWAY_BANK_CODES={"BCA":"014","BNI":"009","BRI":"002","MANDIRI":"008"}  (opsional, lihat catatan)
 */
const crypto = require('crypto');
const LIVE = process.env.GATEWAY_MODE === 'live';
const cfg = {
  baseUrl: (process.env.GATEWAY_BASE_URL || 'https://api.linkqu.id').replace(/\/$/, ''),
  clientId: process.env.GATEWAY_CLIENT_ID, clientSecret: process.env.GATEWAY_CLIENT_SECRET,
  username: process.env.GATEWAY_USERNAME, pin: process.env.GATEWAY_PIN, serverKey: process.env.GATEWAY_SERVER_KEY,
  callbackUrl: process.env.GATEWAY_CALLBACK_URL || 'https://rental.siappgo.id/api/rental/callback',
  email: process.env.GATEWAY_CUSTOMER_EMAIL || 'noreply@example.com'
};
const TTL = (+process.env.PAYMENT_TTL_MINUTES || 15) * 60000;

// PERIKSA: samakan dengan nilai bank_code yang dikirim frontend catur ke /create-va.
let BANK_CODES = { BCA: '014', BNI: '009', BRI: '002', MANDIRI: '008' };
try { if (process.env.GATEWAY_BANK_CODES) BANK_CODES = JSON.parse(process.env.GATEWAY_BANK_CODES); } catch { }

// Format expired LinkQu: YYYYMMDDHHmmss dalam WIB (Asia/Jakarta, UTC+7)
const wib = d => new Date(d.getTime() + 7 * 3600e3).toISOString().replace(/[-:T]/g, '').slice(0, 14);

// Sama persis dengan makeSignature() di catur
function sign(pathUrl, parts) {
  const cleaned = parts.join('').replace(/[^0-9a-zA-Z]/g, '').toLowerCase();
  return crypto.createHmac('sha256', cfg.serverKey).update(pathUrl + 'POST' + cleaned).digest('hex');
}

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

  // ---- LIVE: LinkQu ----
  // partnerRef sengaja BUKAN orderId: orderId tampil di frontend, partnerRef rahasia server.
  // Karena callback LinkQu tidak bertanda tangan, kerahasiaan partnerRef inilah pengamannya.
  const partnerRef = 'LQ-' + orderId + '-' + crypto.randomBytes(8).toString('hex');
  const expired = wib(expiredAt);
  const customerId = orderId, customerName = customer.name, customerEmail = cfg.email;

  let urlPath, parts, extra = {};
  if (method === 'QRIS') {
    urlPath = '/transaction/create/qris';
    parts = [amount, expired, partnerRef, customerId, customerName, customerEmail, cfg.clientId];
  } else {
    const bankCode = BANK_CODES[bank];
    if (!bankCode) throw new Error('Kode bank tidak dikenal: ' + bank);
    urlPath = '/transaction/create/va';
    extra = { bank_code: bankCode };
    parts = [amount, expired, bankCode, partnerRef, customerId, customerName, customerEmail, cfg.clientId];
  }

  const payload = {
    ...extra, amount, partner_reff: partnerRef, username: cfg.username, pin: cfg.pin, expired,
    signature: sign(urlPath, parts), url_callback: cfg.callbackUrl,
    customer_id: customerId, customer_name: customerName, customer_email: customerEmail
  };

  // Log request: pin, signature, & kredensial TIDAK dicetak
  console.log('[gateway:create] REQUEST', JSON.stringify({
    order: orderId, method, bank, url: cfg.baseUrl + '/linkqu-partner' + urlPath,
    amount, partner_reff: partnerRef, expired, url_callback: cfg.callbackUrl,
    bank_code: extra.bank_code, customer_id: customerId, customer_name: customerName, customer_email: customerEmail
  }));

  const t0 = Date.now();
  let res, j;
  try {
    res = await fetch(cfg.baseUrl + '/linkqu-partner' + urlPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'client-id': cfg.clientId, 'client-secret': cfg.clientSecret },
      body: JSON.stringify(payload)
    });
    j = await res.json().catch(() => ({}));
  } catch (e) {
    console.error('[gateway:create] NETWORK ERROR', orderId, e.message);
    throw e;
  }
  console.log('[gateway:create] RESPONSE', JSON.stringify({ order: orderId, http: res.status, ms: Date.now() - t0, body: j }));

  const vaNumber = j.virtual_account || undefined;
  const qrImageUrl = j.imageqris ? String(j.imageqris).trim() : undefined;
  const ok = res.ok && (method === 'QRIS' ? qrImageUrl : vaNumber);
  if (!ok) {
    console.error('[gateway:create] GAGAL', orderId, 'http=' + res.status);
    throw new Error('LinkQu ' + res.status + ': ' + (j.message || j.response_desc || JSON.stringify(j).slice(0, 200)));
  }
  console.log('[gateway:create] OK', JSON.stringify({ order: orderId, partnerRef, va: vaNumber, qris: !!qrImageUrl }));

  return { partnerRef, vaNumber, qrString: j.qris_string || j.qris || undefined, qrImageUrl, expiredAt, raw: j };
}

// Callback LinkQu (dari kode catur) tidak memakai signature/header apa pun.
// Isinya: { partner_reff, va_code, serialnumber, ... } dan hanya dikirim saat pembayaran sukses.
// Keamanan: partnerRef acak & rahasia + cek nominal/duplikat di markPaid().
function verifyCallback(req) {
  console.log('[gateway:callback] DITERIMA', JSON.stringify({ ip: req.ip, body: req.body }));
  return true;
}

function parseCallback(body) {
  const partnerRef = body.partner_reff || body.partner_ref || body.partnerRef;
  const s = String(body.status || '').toUpperCase();
  let status = null;
  if (!s) status = partnerRef ? 'PAID' : null; // tanpa field status = notifikasi sukses (perilaku catur)
  else if (['PAID', 'SUCCESS', 'SUKSES', 'SETTLED'].includes(s)) status = 'PAID';
  else if (s === 'EXPIRED') status = 'EXPIRED';
  else if (['FAILED', 'CANCELLED', 'GAGAL'].includes(s)) status = 'FAILED';
  console.log('[gateway:callback] PARSE', JSON.stringify({ partnerRef, status, amount: body.amount ?? null }));
  return { partnerRef, status, amount: body.amount, raw: body };
}

module.exports = { createPayment, verifyCallback, parseCallback, LIVE };