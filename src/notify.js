/**
 * Notifikasi WhatsApp via Twilio REST API (tanpa dependency tambahan, butuh Node 18+).
 * Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WA_FROM (mis. +14155238886 atau whatsapp:+14155238886),
 *      TWILIO_CONTENT_SID (opsional, SID template "HX..."; tanpa ini dikirim teks biasa).
 * Catatan: pesan teks biasa hanya bisa dikirim ke nomor yang chat dengan Anda dalam 24 jam terakhir.
 * Untuk pesan pertama ke pelanggan baru, Twilio mewajibkan template yang sudah disetujui.
 */
const sid = process.env.TWILIO_ACCOUNT_SID, token = process.env.TWILIO_AUTH_TOKEN;
const from = process.env.TWILIO_WA_FROM, contentSid = process.env.TWILIO_CONTENT_SID;
const wa = n => 'whatsapp:' + (String(n).startsWith('whatsapp:') ? String(n).slice(9) : (String(n).startsWith('+') ? n : '+' + n));

async function sendWhatsApp(to, { vars, body }) {
    if (!sid || !token || !from) { console.log('[wa] Twilio belum dikonfigurasi, notifikasi dilewati'); return false; }
    const p = new URLSearchParams({ From: wa(from), To: wa(to) });
    if (contentSid) { p.set('ContentSid', contentSid); p.set('ContentVariables', JSON.stringify(vars)); }
    else p.set('Body', body);
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: 'Basic ' + Buffer.from(sid + ':' + token).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: p
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Twilio ${res.status}${j.code ? ' (' + j.code + ')' : ''}: ${j.message || ''}`);
    return true;
}

module.exports = { sendWhatsApp };