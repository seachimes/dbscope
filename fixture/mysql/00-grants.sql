-- The fixture grants its diagnostic user read access to performance_schema.
-- DBSCOPE still works without this permission (it reports
-- the reason and falls back to rule-based detection) — the fixture grants it so
-- the query-statistics path gets exercised too.
GRANT SELECT ON performance_schema.* TO 'appuser'@'%';
GRANT PROCESS ON *.* TO 'appuser'@'%';
FLUSH PRIVILEGES;
