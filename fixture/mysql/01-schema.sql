-- Sample application schema, deliberately under-indexed for diagnostics.
-- The point of the fixture is that `DBSCOPE` must SEE the pain:
--   posts.user_id      -> no index  => FULL SCAN
--   posts.created_at   -> no index  => FILESORT on the timeline query
--   comments.post_id   -> no index  => N+1 full scans
--   no FOREIGN KEYs at all          => relations must be INFERRED, not read

SET NAMES utf8mb4;
SET GLOBAL local_infile = 1;

CREATE DATABASE IF NOT EXISTS appdb DEFAULT CHARACTER SET utf8mb4;
USE appdb;

CREATE TABLE users (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  account_name VARCHAR(64)  NOT NULL,
  passhash     VARCHAR(128) NOT NULL,
  authority    TINYINT(1)   NOT NULL DEFAULT 0,
  del_flg      TINYINT(1)   NOT NULL DEFAULT 0,
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_account_name (account_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The big one. PK only. Every timeline query will hurt.
CREATE TABLE posts (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id    INT UNSIGNED NOT NULL,
  mime       VARCHAR(64)  NOT NULL,
  body       TEXT         NOT NULL,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Bigger still, and joined against posts constantly.
CREATE TABLE comments (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  post_id    INT UNSIGNED NOT NULL,
  user_id    INT UNSIGNED NOT NULL,
  comment    TEXT         NOT NULL,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE reactions (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  post_id    INT UNSIGNED NOT NULL,
  user_id    INT UNSIGNED NOT NULL,
  kind       TINYINT UNSIGNED NOT NULL DEFAULT 1,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_post_id (post_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A small, healthy table: proves the tool does not cry wolf everywhere.
CREATE TABLE categories (
  id   INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(64) NOT NULL,
  UNIQUE KEY uniq_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One table WITH a real FK, so FK-based relations are exercised too.
CREATE TABLE post_categories (
  post_id     INT UNSIGNED NOT NULL,
  category_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (post_id, category_id),
  KEY fk_pc_category (category_id),
  CONSTRAINT fk_pc_category FOREIGN KEY (category_id) REFERENCES categories (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
