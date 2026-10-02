CREATE TABLE IF NOT EXISTS `payment_method` (
  `id`              CHAR(36)      NOT NULL,
  `code`            VARCHAR(48)   NOT NULL,
  `display_name`    VARCHAR(96)   NOT NULL,
  `kind`            VARCHAR(24)   NOT NULL DEFAULT 'manual',
  `logo_url`        VARCHAR(512)  NULL,
  `currency`        VARCHAR(16)   NOT NULL DEFAULT 'PKR',
  `enabled`         TINYINT(1)    NOT NULL DEFAULT 1,
  `supports_deposit`    TINYINT(1) NOT NULL DEFAULT 1,
  `supports_withdrawal` TINYINT(1) NOT NULL DEFAULT 0,
  `min_deposit`     DECIMAL(38,2) NOT NULL DEFAULT 0,
  `max_deposit`     DECIMAL(38,2) NULL,
  `min_withdrawal`  DECIMAL(38,2) NOT NULL DEFAULT 0,
  `max_withdrawal`  DECIMAL(38,2) NULL,
  `deposit_fee_pct`    DECIMAL(6,3) NOT NULL DEFAULT 0,
  `withdrawal_fee_pct` DECIMAL(6,3) NOT NULL DEFAULT 0,
  `instructions`    TEXT          NULL,
  `pay_to_details`  TEXT          NULL,
  `required_fields` JSON          NULL,
  `sort_order`      INT           NOT NULL DEFAULT 0,
  `created_at`      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `payment_method_code_uq` (`code`),
  KEY `payment_method_order_idx` (`enabled`, `sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `player_payout_account` (
  `id`            CHAR(36)     NOT NULL,
  `user_id`       VARCHAR(64)  NOT NULL,
  `method_id`     CHAR(36)     NOT NULL,
  `label`         VARCHAR(96)  NOT NULL,
  `details`       JSON         NOT NULL,
  `created_at`    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `payout_account_user_idx` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `deposit` (
  `id`            CHAR(36)      NOT NULL,
  `reference`     VARCHAR(32)   NOT NULL,
  `user_id`       VARCHAR(64)   NOT NULL,
  `method_id`     CHAR(36)      NOT NULL,
  `currency`      VARCHAR(16)   NOT NULL,
  `amount`        DECIMAL(38,2) NOT NULL,
  `credited`      DECIMAL(38,2) NULL,
  `status`        VARCHAR(16)   NOT NULL DEFAULT 'pending',
  `player_note`   VARCHAR(255)  NULL,
  `proof_url`     VARCHAR(512)  NULL,
  `admin_note`    VARCHAR(255)  NULL,
  `processed_by`  VARCHAR(64)   NULL,
  `processed_at`  DATETIME      NULL,
  `created_at`    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `deposit_reference_uq` (`reference`),
  KEY `deposit_user_idx` (`user_id`, `created_at`),
  KEY `deposit_status_idx` (`status`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `withdrawal` (
  `id`            CHAR(36)      NOT NULL,
  `reference`     VARCHAR(32)   NOT NULL,
  `user_id`       VARCHAR(64)   NOT NULL,
  `method_id`     CHAR(36)      NOT NULL,
  `account_id`    CHAR(36)      NULL,
  `currency`      VARCHAR(16)   NOT NULL,
  `amount`        DECIMAL(38,2) NOT NULL,
  `fee`           DECIMAL(38,2) NOT NULL DEFAULT 0,
  `payable`       DECIMAL(38,2) NOT NULL,
  `status`        VARCHAR(16)   NOT NULL DEFAULT 'pending',
  `details`       JSON          NULL,
  `admin_note`    VARCHAR(255)  NULL,
  `processed_by`  VARCHAR(64)   NULL,
  `processed_at`  DATETIME      NULL,
  `created_at`    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `withdrawal_reference_uq` (`reference`),
  KEY `withdrawal_user_idx` (`user_id`, `created_at`),
  KEY `withdrawal_status_idx` (`status`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `balance_adjustment` (
  `id`              CHAR(36)      NOT NULL,
  `user_id`         VARCHAR(64)   NOT NULL,
  `currency`        VARCHAR(16)   NOT NULL,
  `delta`           DECIMAL(38,2) NOT NULL,
  `balance_before`  DECIMAL(38,2) NOT NULL,
  `balance_after`   DECIMAL(38,2) NOT NULL,
  `reason`          VARCHAR(255)  NOT NULL,
  `admin_id`        VARCHAR(64)   NOT NULL,
  `created_at`      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `adjustment_user_idx` (`user_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `banner` (
  `id`           CHAR(36)     NOT NULL,
  `title`        VARCHAR(160) NOT NULL,
  `subtitle`     VARCHAR(255) NULL,
  `image_url`    VARCHAR(512) NULL,
  `mobile_image_url` VARCHAR(512) NULL,
  `cta_text`     VARCHAR(64)  NULL,
  `cta_link`     VARCHAR(512) NULL,
  `enabled`      TINYINT(1)   NOT NULL DEFAULT 1,
  `starts_at`    DATETIME     NULL,
  `ends_at`      DATETIME     NULL,
  `sort_order`   INT          NOT NULL DEFAULT 0,
  `created_at`   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `banner_live_idx` (`enabled`, `sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `promotion` (
  `id`            CHAR(36)      NOT NULL,
  `slug`          VARCHAR(64)   NOT NULL,
  `title`         VARCHAR(160)  NOT NULL,
  `summary`       VARCHAR(255)  NULL,
  `body`          TEXT          NULL,
  `image_url`     VARCHAR(512)  NULL,
  `bonus_pct`     DECIMAL(6,2)  NULL,
  `min_deposit`   DECIMAL(38,2) NULL,
  `max_bonus`     DECIMAL(38,2) NULL,
  `terms`         TEXT          NULL,
  `enabled`       TINYINT(1)    NOT NULL DEFAULT 1,
  `starts_at`     DATETIME      NULL,
  `ends_at`       DATETIME      NULL,
  `sort_order`    INT           NOT NULL DEFAULT 0,
  `created_at`    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `promotion_slug_uq` (`slug`),
  KEY `promotion_live_idx` (`enabled`, `sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `site_setting` (
  `key_name`   VARCHAR(64)  NOT NULL,
  `value`      TEXT         NULL,
  `updated_at` TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`key_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `admin_audit_log` (
  `id`         BIGINT       NOT NULL AUTO_INCREMENT,
  `admin_id`   VARCHAR(64)  NOT NULL,
  `action`     VARCHAR(64)  NOT NULL,
  `target`     VARCHAR(128) NULL,
  `metadata`   JSON         NULL,
  `ip`         VARCHAR(45)  NULL,
  `created_at` TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `audit_admin_idx` (`admin_id`, `created_at`),
  KEY `audit_action_idx` (`action`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO `site_setting` (`key_name`, `value`) VALUES
  ('site_name', 'BS Exchange'),
  ('currency_display', 'PKR'),
  ('support_whatsapp', ''),
  ('support_telegram', ''),
  ('support_email', ''),
  ('maintenance_mode', '0')
ON DUPLICATE KEY UPDATE `value` = `value`;
