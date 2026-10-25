-- Rental Mobil IKN–Balikpapan (LinkU) · MySQL 8+
-- Semua waktu (created_at, expired_at, paid_at) disimpan dalam UTC.
CREATE DATABASE IF NOT EXISTS rental_linku CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE rental_linku;

-- Master mobil: harga di-lookup di server, frontend tidak pernah menentukan harga.
CREATE TABLE IF NOT EXISTS rental_cars (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code        VARCHAR(30)  NOT NULL UNIQUE,
  name        VARCHAR(80)  NOT NULL,
  price_12h   INT UNSIGNED NOT NULL COMMENT 'Rupiah, paket 1 hari (12 jam) + driver',
  active      TINYINT(1)   NOT NULL DEFAULT 1,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

INSERT INTO rental_cars (code, name, price_12h) VALUES
 ('AVANZA',        'Avanza / Xenia / Confero', 750000),
 ('TERIOS',        'Terios / Xpander / Rush',  800000),
 ('INNOVA_REBORN', 'Innova Reborn',            950000),
 ('INNOVA_ZENIX',  'Innova Zenix',            1100000)
ON DUPLICATE KEY UPDATE name = VALUES(name), price_12h = VALUES(price_12h);

CREATE TABLE IF NOT EXISTS rental_orders (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id         VARCHAR(24)  NOT NULL UNIQUE COMMENT 'ID publik, mis. RM-251025-AB12C',
  customer_name    VARCHAR(100) NOT NULL,
  whatsapp         VARCHAR(20)  NOT NULL COMMENT 'format 628xxxxxxxxxx',
  car_code         VARCHAR(30)  NOT NULL,
  car_name         VARCHAR(80)  NOT NULL COMMENT 'snapshot nama saat order',
  duration_code    VARCHAR(10)  NOT NULL DEFAULT '1D12H',
  usage_date       DATE         NOT NULL,
  pickup_time      TIME         NOT NULL,
  passengers       TINYINT UNSIGNED NOT NULL,
  pickup_location  VARCHAR(200) NOT NULL,
  destination      VARCHAR(200) NOT NULL,
  notes            VARCHAR(300) NULL,
  total_amount     INT UNSIGNED NOT NULL COMMENT 'snapshot harga saat order',
  payment_method   ENUM('QRIS','VA') NOT NULL,
  bank             VARCHAR(20)  NULL,
  status           ENUM('PENDING','PAID','EXPIRED','FAILED') NOT NULL DEFAULT 'PENDING',
  paid_at          DATETIME     NULL,
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_status_created (status, created_at),
  KEY idx_usage_date (usage_date),
  KEY idx_whatsapp (whatsapp),
  CONSTRAINT fk_order_car FOREIGN KEY (car_code) REFERENCES rental_cars(code)
) ENGINE=InnoDB;

-- Satu order bisa punya beberapa percobaan pembayaran (mis. dibuat ulang setelah kedaluwarsa).
CREATE TABLE IF NOT EXISTS rental_payments (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id      VARCHAR(24)  NOT NULL,
  partner_ref   VARCHAR(80)  NOT NULL UNIQUE COMMENT 'referensi/ID transaksi dari payment gateway',
  method        ENUM('QRIS','VA') NOT NULL,
  bank          VARCHAR(20)  NULL,
  va_number     VARCHAR(32)  NULL,
  qr_string     TEXT         NULL,
  qr_image_url  VARCHAR(500) NULL,
  amount        INT UNSIGNED NOT NULL,
  status        ENUM('PENDING','PAID','EXPIRED','FAILED') NOT NULL DEFAULT 'PENDING',
  expired_at    DATETIME     NOT NULL,
  paid_at       DATETIME     NULL,
  gateway_response JSON      NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_order (order_id),
  KEY idx_status_exp (status, expired_at),
  CONSTRAINT fk_pay_order FOREIGN KEY (order_id) REFERENCES rental_orders(order_id)
) ENGINE=InnoDB;

-- Audit semua callback yang masuk (termasuk yang ditolak) untuk investigasi & rekonsiliasi.
CREATE TABLE IF NOT EXISTS rental_webhook_logs (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  partner_ref VARCHAR(80)  NULL,
  verified    TINYINT(1)   NOT NULL,
  result      VARCHAR(40)  NOT NULL COMMENT 'ok | duplicate | amount_mismatch | unknown_ref | bad_signature',
  payload     JSON         NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ref (partner_ref)
) ENGINE=InnoDB;
