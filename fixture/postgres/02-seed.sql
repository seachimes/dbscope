-- Mirrors fixture/mysql/02-seed.sql row for row.
--
-- The same doubling strategy is used rather than a single generate_series, so
-- the id/user_id distribution matches MySQL exactly: the id * 7 fan-out is what
-- decides how many posts each user owns, and therefore what the planner
-- estimates for `WHERE user_id = ?`. A different distribution would make the
-- two engines disagree for reasons that have nothing to do with the engines.

-- ---------- users: 2,000 ----------
INSERT INTO users (account_name, passhash, authority, del_flg, created_at)
SELECT
  'user_' || lpad(n::text, 6, '0'),
  encode(sha512(('pass' || n)::bytea), 'hex'),
  CASE WHEN n % 200 = 0 THEN 1 ELSE 0 END,
  CASE WHEN n % 97 = 0 THEN 1 ELSE 0 END,
  now() - (n * 7 || ' minutes')::interval
FROM generate_series(1, 2000) AS n;

-- ---------- categories: 12 ----------
INSERT INTO categories (name) VALUES
  ('tech'), ('food'), ('travel'), ('music'), ('sports'), ('art'),
  ('game'), ('book'), ('movie'), ('pet'), ('photo'), ('misc');

-- ---------- posts: seed 1,024 then double to 262,144 ----------
INSERT INTO posts (user_id, mime, body, created_at)
SELECT
  1 + (n % 2000),
  (ARRAY['image/jpeg', 'image/png', 'image/gif'])[1 + (n % 3)],
  'post body ' || n || ' ' || repeat('x', 40 + (n % 120)),
  now() - (n || ' minutes')::interval
FROM generate_series(1, 1024) AS n;

-- 1,024 -> 262,144 (8 doublings).
--
-- Derived values use row_number(), matching the MySQL seed. MySQL cannot key
-- these off `id`, because InnoDB allocates auto-increment values in blocks for
-- INSERT ... SELECT and leaves gaps; both files therefore use the row's ordinal
-- position so the two engines end up with identical data.
DO $$
BEGIN
  FOR i IN 1..8 LOOP
    INSERT INTO posts (user_id, mime, body, created_at)
    SELECT 1 + ((rn * 7) % 2000), mime, body, created_at - (rn || ' minutes')::interval
    FROM (SELECT row_number() OVER (ORDER BY id) rn, mime, body, created_at FROM posts) t;
  END LOOP;
END $$;

-- ---------- comments: 524,288, ~2 per post ----------
INSERT INTO comments (post_id, user_id, comment, created_at)
SELECT id, 1 + ((rn * 13) % 2000), 'nice post #' || rn, created_at + interval '3 minutes'
FROM (SELECT id, row_number() OVER (ORDER BY id) rn, created_at FROM posts) t;
INSERT INTO comments (post_id, user_id, comment, created_at)
SELECT post_id, 1 + ((rn * 31) % 2000), 're: ' || comment, created_at + interval '5 minutes'
FROM (SELECT post_id, row_number() OVER (ORDER BY id) rn, comment, created_at FROM comments) t;

-- ---------- reactions: 262,144 (this one IS indexed on post_id) ----------
INSERT INTO reactions (post_id, user_id, kind, created_at)
SELECT id, 1 + ((rn * 17) % 2000), 1 + (rn % 4), created_at + interval '1 minute'
FROM (SELECT id, row_number() OVER (ORDER BY id) rn, created_at FROM posts) t;

-- ---------- post_categories: every 16th post gets a category ----------
INSERT INTO post_categories (post_id, category_id)
SELECT id, 1 + (rn % 12)
FROM (SELECT id, row_number() OVER (ORDER BY id) rn FROM posts) t
WHERE rn % 16 = 0
ON CONFLICT DO NOTHING;

-- Row estimates come from the planner's statistics, so they must be current
-- before DBSCOPE reads them.
ANALYZE;
