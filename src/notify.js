/**
 * Notifikasi WhatsApp via Twilio REST API (tanpa dependency tambahan, butuh Node 18+).
 * Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WA_FROM (mis. +62812... atau whatsapp:+62812...),
 *      TWILIO_CUSTOMER_CONTENT_SID  SID template pelanggan ("HX...")
 *      TWILIO_ADMIN_CONTENT_SID     SID template admin ("HX...")
 *      TWILIO_CONTENT_SID           (opsional, cadangan bila dua di atas kosong)
 * Tanpa SID sama sekali, dikirim teks biasa (hanya sampai ke nomor yang chat dengan Anda dalam 24 jam).
 * Pesan pertama ke nomor baru WAJIB memakai template yang sudah Approved.
 */
const sid = process.env.TWILIO_ACCOUNT_SID, token = process.env.TWILIO_AUTH_TOKEN;
const from = process.env.TWILIO_WA_FROM || "whatsapp:+62882005447472";
const SIDS = {
    customer: process.env.TWILIO_CUSTOMER_CONTENT_SID || 'HX66688b49de89d91652928738d18821fe',
    admin: process.env.TWILIO_ADMIN_CONTENT_SID || 'HXbbd77478e768bd818b3a10e37e1cec39'
};
const wa = n => 'whatsapp:' + (String(n).startsWith('whatsapp:') ? String(n).slice(9) : (String(n).startsWith('+') ? n : '+' + n));

// Variabel template tidak boleh kosong, berisi baris baru/tab, atau 4+ spasi berurutan
const one = s => String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim() || '-';
const cleanVars = v => Object.fromEntries(Object.entries(v || {}).map(([k, x]) => [k, one(x)]));

async function sendWhatsApp(to, { vars, body, role }) {
    if (!sid || !token || !from) { console.log('[wa] Twilio belum dikonfigurasi, notifikasi dilewati'); return false; }
    const contentSid = SIDS[role];
    const p = new URLSearchParams({ From: wa(from), To: wa(to) });
    if (contentSid) { p.set('ContentSid', contentSid); p.set('ContentVariables', JSON.stringify(cleanVars(vars))); }
    else p.set('Body', body);
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: 'Basic ' + Buffer.from(sid + ':' + token).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: p
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Twilio ${res.status}${j.code ? ' (' + j.code + ')' : ''}: ${j.message || ''}`);
    console.log(`[wa] terkirim ke ...${String(to).slice(-4)} (${role}, ${contentSid ? 'template' : 'teks'})`);
    return true;
}

module.exports = { sendWhatsApp };