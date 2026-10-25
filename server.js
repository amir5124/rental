require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { router, startExpiryJob } = require('./src/rental');

const app = express();
app.set('trust proxy', 1); // di belakang Coolify / reverse proxy
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors()); // semua origin diizinkan (termasuk file:// dengan origin "null")
// simpan body mentah (dipakai jika suatu saat perlu verifikasi signature callback)
app.use(express.json({ limit: '50kb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/api/rental', router);
app.use((_req, res) => res.status(404).json({ success: false, message: 'Not found' }));

const port = +process.env.PORT || 3000;
app.listen(port, () => {
    console.log('Rental backend :' + port, 'gateway=' + (process.env.GATEWAY_MODE || 'mock'));
    startExpiryJob();
});