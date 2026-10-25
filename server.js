require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { router, startExpiryJob } = require('./src/rental');

const app = express();
app.set('trust proxy', 1); // di belakang Coolify / reverse proxy
app.use(helmet());
const origins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({ origin: origins.length ? origins : false }));
// simpan body mentah untuk verifikasi signature callback
app.use(express.json({ limit: '50kb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/api/rental', router);
app.use((_req, res) => res.status(404).json({ success: false, message: 'Not found' }));

const port = +process.env.PORT || 3000;
app.listen(port, () => { console.log('Rental backend :' + port, 'gateway=' + (process.env.GATEWAY_MODE || 'mock')); startExpiryJob(); });
