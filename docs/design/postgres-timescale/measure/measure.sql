\pset format unaligned
\pset fieldsep '|'
\pset tuples_only on
SET timescaledb.enable_chunk_skipping = on;
SELECT 'chunks', count(*) FROM show_chunks('templates');
SELECT 'uncompressed_total', pg_size_pretty(hypertable_size('templates')), hypertable_size('templates');
SELECT 'uncompressed_detail', pg_size_pretty(table_bytes), pg_size_pretty(index_bytes), pg_size_pretty(toast_bytes) FROM hypertable_detailed_size('templates');
SELECT 'compress', count(*) FROM (SELECT compress_chunk(c, if_not_compressed => true) FROM show_chunks('templates') c) x;
SELECT 'compress_other', count(*) FROM (SELECT compress_chunk(c, if_not_compressed => true) FROM show_chunks('templates_other') c) x;
SELECT 'compressed_total', pg_size_pretty(hypertable_size('templates')), hypertable_size('templates');
SELECT 'columnstore_stats', pg_size_pretty(sum(before_compression_total_bytes)), pg_size_pretty(sum(after_compression_total_bytes)), round(sum(before_compression_total_bytes)::numeric / nullif(sum(after_compression_total_bytes), 0), 2) FROM hypertable_columnstore_stats('templates');
SELECT 'other_total', pg_size_pretty(hypertable_size('templates_other'));
SELECT 'merkle_sets_table', coalesce(pg_size_pretty(pg_total_relation_size(to_regclass('merkle_branch_sets'))), '-'), coalesce(pg_total_relation_size(to_regclass('merkle_branch_sets')), 0);
SELECT 'rows', (SELECT count(*) FROM templates), (SELECT count(*) FROM templates_other);
