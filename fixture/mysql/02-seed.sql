-- Seed enough rows that a full scan is visibly expensive but the fixture still
-- boots in well under a minute. Doubling INSERT...SELECT is the fastest way
-- to get there without loading a dump file.
USE appdb;

SET SESSION cte_max_recursion_depth = 100000;
SET SESSION sql_log_bin = 0;

-- ---------- users: 2,000 ----------
INSERT INTO users (account_name, passhash, authority, del_flg, created_at)
WITH RECURSIVE seq (n) AS (
  SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 2000
)
SELECT
  CONCAT('user_', LPAD(n, 6, '0')),
  SHA2(CONCAT('pass', n), 512),
  IF(n % 200 = 0, 1, 0),
  IF(n % 97 = 0, 1, 0),
  NOW() - INTERVAL (n * 7) MINUTE
FROM seq;

-- ---------- categories: 12 ----------
INSERT INTO categories (name) VALUES
  ('tech'), ('food'), ('travel'), ('music'), ('sports'), ('art'),
  ('game'), ('book'), ('movie'), ('pet'), ('photo'), ('misc');

-- ---------- posts: seed 1,024 then double to ~262,144 ----------
INSERT INTO posts (user_id, mime, body, created_at)
WITH RECURSIVE seq (n) AS (
  SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 1024
)
SELECT
  1 + (n % 2000),
  ELT(1 + (n % 3), 'image/jpeg', 'image/png', 'image/gif'),
  CONCAT('post body ', n, ' ', REPEAT('x', 40 + (n % 120))),
  NOW() - INTERVAL n MINUTE
FROM seq;

-- 1,024 -> 262,144 (8 doublings).
--
-- Derived values use ROW_NUMBER(), not `id`. InnoDB allocates auto-increment
-- values in blocks for INSERT ... SELECT, so `id` ends up with gaps (max 393,207
-- for 262,144 rows) while PostgreSQL's identity column stays contiguous. Keying
-- the fan-out on `id` would therefore give the two engines different user_id
-- distributions, and the planner would estimate differently for reasons that
-- have nothing to do with the engines.
INSERT INTO posts (user_id, mime, body, created_at)
  SELECT 1 + ((rn * 7) % 2000), mime, body, created_at - INTERVAL rn MINUTE
  FROM (SELECT ROW_NUMBER() OVER (ORDER BY id) rn, mime, body, created_at FROM posts) t;
INSERT INTO posts (user_id, mime, body, created_at)
  SELECT 1 + ((rn * 7) % 2000), mime, body, created_at - INTERVAL rn MINUTE
  FROM (SELECT ROW_NUMBER() OVER (ORDER BY id) rn, mime, body, created_at FROM posts) t;
INSERT INTO posts (user_id, mime, body, created_at)
  SELECT 1 + ((rn * 7) % 2000), mime, body, created_at - INTERVAL rn MINUTE
  FROM (SELECT ROW_NUMBER() OVER (ORDER BY id) rn, mime, body, created_at FROM posts) t;
INSERT INTO posts (user_id, mime, body, created_at)
  SELECT 1 + ((rn * 7) % 2000), mime, body, created_at - INTERVAL rn MINUTE
  FROM (SELECT ROW_NUMBER() OVER (ORDER BY id) rn, mime, body, created_at FROM posts) t;
INSERT INTO posts (user_id, mime, body, created_at)
  SELECT 1 + ((rn * 7) % 2000), mime, body, created_at - INTERVAL rn MINUTE
  FROM (SELECT ROW_NUMBER() OVER (ORDER BY id) rn, mime, body, created_at FROM posts) t;
INSERT INTO posts (user_id, mime, body, created_at)
  SELECT 1 + ((rn * 7) % 2000), mime, body, created_at - INTERVAL rn MINUTE
  FROM (SELECT ROW_NUMBER() OVER (ORDER BY id) rn, mime, body, created_at FROM posts) t;
INSERT INTO posts (user_id, mime, body, created_at)
  SELECT 1 + ((rn * 7) % 2000), mime, body, created_at - INTERVAL rn MINUTE
  FROM (SELECT ROW_NUMBER() OVER (ORDER BY id) rn, mime, body, created_at FROM posts) t;
INSERT INTO posts (user_id, mime, body, created_at)
  SELECT 1 + ((rn * 7) % 2000), mime, body, created_at - INTERVAL rn MINUTE
  FROM (SELECT ROW_NUMBER() OVER (ORDER BY id) rn, mime, body, created_at FROM posts) t;

-- Close the auto-increment gaps before anything references posts.id.
--
-- InnoDB allocates auto-increment values in blocks for INSERT ... SELECT, so
-- after eight doublings the ids run 1..393,207 for 262,144 rows. PostgreSQL's
-- identity column has no such gaps. Compacting the ids here is what lets
-- comments.post_id and reactions.post_id hold the same values in both engines,
-- which is the whole point of running the two side by side.
SET @row = 0;
UPDATE posts SET id = (@row := @row + 1) ORDER BY id;
ALTER TABLE posts AUTO_INCREMENT = 1;

-- ---------- comments: 524,288, ~2 per post ----------
INSERT INTO comments (post_id, user_id, comment, created_at)
  SELECT id, 1 + ((rn * 13) % 2000), CONCAT('nice post #', rn), created_at + INTERVAL 3 MINUTE
  FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY id) rn, created_at FROM posts) t;
INSERT INTO comments (post_id, user_id, comment, created_at)
  SELECT post_id, 1 + ((rn * 31) % 2000), CONCAT('re: ', comment), created_at + INTERVAL 5 MINUTE
  FROM (SELECT post_id, ROW_NUMBER() OVER (ORDER BY id) rn, comment, created_at FROM comments) t;

-- Same reason as posts: keep comments.id contiguous so both engines agree.
SET @row = 0;
UPDATE comments SET id = (@row := @row + 1) ORDER BY id;
ALTER TABLE comments AUTO_INCREMENT = 1;

-- ---------- reactions: 262,144 (this one IS indexed on post_id) ----------
INSERT INTO reactions (post_id, user_id, kind, created_at)
  SELECT id, 1 + ((rn * 17) % 2000), 1 + (rn % 4), created_at + INTERVAL 1 MINUTE
  FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY id) rn, created_at FROM posts) t;

-- ---------- post_categories: every 16th post gets a category ----------
INSERT IGNORE INTO post_categories (post_id, category_id)
  SELECT id, 1 + (rn % 12)
  FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY id) rn FROM posts) t
  WHERE rn % 16 = 0;

ANALYZE TABLE users, posts, comments, reactions, categories, post_categories;
