import argparse
import glob
import logging
import os
import sys
import time
from typing import List, Tuple

from bson.json_util import loads as bson_loads
from pymongo import MongoClient
from pymongo.errors import BulkWriteError, PyMongoError


LOG = logging.getLogger("mongo-height-import")


def parse_args():
    parser = argparse.ArgumentParser(
        description=(
            "Import MongoDB documents from Extended JSON dump files (created by mongo_height_dump.py)\n"
            "Reads all matching JSON files in a folder and inserts them into the target collection."
        )
    )
    parser.add_argument(
        "--mongo-uri",
        required=True,
        help="MongoDB connection string URI (e.g., mongodb://user:pass@host:27017/dbname)",
    )
    parser.add_argument(
        "--db-name",
        default="stratum-logger-restore",
        help="Target MongoDB database name (default: stratum-logger-restore)",
    )
    parser.add_argument(
        "--collection",
        default="mining_notify",
        help="Target collection name to import into (default: mining_notify)",
    )
    parser.add_argument(
        "--input-dir",
        required=True,
        help="Directory containing JSON dump files to import",
    )
    parser.add_argument(
        "--pattern",
        default="*.json",
        help="Glob pattern to match files within input-dir (default: *.json)",
    )
    parser.add_argument(
        "--drop-first",
        action="store_true",
        help="Drop the target collection before importing",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"],
        help="Logging level (default: INFO)",
    )
    parser.add_argument(
        "--continue-on-error",
        action="store_true",
        help=(
            "Continue on non-duplicate-key errors during bulk inserts (default: stop on first non-duplicate error)"
        ),
    )
    return parser.parse_args()


def discover_files(input_dir: str, pattern: str) -> List[str]:
    search = os.path.join(input_dir, pattern)
    candidates = [p for p in glob.glob(search) if os.path.isfile(p)]

    def sort_key(path: str) -> Tuple[int, int, str]:
        # Dump files are named as "<high>-<low>.json" by mongo_height_dump.py
        # Sort by low then high numerically if possible; otherwise fallback to name
        base = os.path.basename(path)
        name, _ = os.path.splitext(base)
        parts = name.split("-")
        if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
            high = int(parts[0])
            low = int(parts[1])
            return (low, high, base)
        return (sys.maxsize, sys.maxsize, base)

    candidates.sort(key=sort_key)
    return candidates


def read_dump_file(file_path: str):
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()
    try:
        data = bson_loads(content)
    except Exception as exc:  # noqa: BLE001 - surface parse errors
        raise ValueError(f"Failed to parse Extended JSON in {file_path}: {exc}") from exc

    if isinstance(data, list):
        return data
    if data is None:
        return []
    return [data]


def insert_documents(collection, docs: List[dict], continue_on_error: bool) -> Tuple[int, int, int]:
    if not docs:
        return (0, 0, 0)

    try:
        result = collection.insert_many(docs, ordered=False)
        inserted = len(result.inserted_ids)
        return (inserted, 0, 0)
    except BulkWriteError as bwe:  # noqa: PERF203 - bulk failures are expected sometimes
        details = bwe.details or {}
        write_errors = details.get("writeErrors", [])
        duplicate_errors = [e for e in write_errors if e.get("code") == 11000]
        non_duplicate_errors = [e for e in write_errors if e.get("code") != 11000]

        dup_count = len(duplicate_errors)
        nondup_count = len(non_duplicate_errors)

        # With ordered=False, operations after errors still run; approximate inserted count
        # as total attempts minus total errors. This is an estimate consistent with pymongo behavior.
        inserted_estimate = max(0, len(docs) - len(write_errors))

        if nondup_count and not continue_on_error:
            # Surface the first non-duplicate error for visibility and stop
            sample = non_duplicate_errors[0]
            err_code = sample.get("code", "?")
            err_msg = sample.get("errmsg", str(sample))
            raise RuntimeError(
                f"Bulk insert failed with non-duplicate error code={err_code}: {err_msg}"
            ) from bwe

        return (inserted_estimate, dup_count, nondup_count)


def main():
    args = parse_args()

    # Configure logging
    log_level = getattr(logging, args.log_level.upper(), logging.INFO)
    logging.basicConfig(
        stream=sys.stdout,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        level=log_level,
    )

    if not os.path.isdir(args.input_dir):
        print(f"input-dir does not exist or is not a directory: {args.input_dir}", file=sys.stderr)
        sys.exit(2)

    files = discover_files(args.input_dir, args.pattern)
    if not files:
        print("No files matched for import.", file=sys.stderr)
        sys.exit(1)

    LOG.info("Connecting to MongoDB and selecting db '%s', collection '%s'", args.db_name, args.collection)
    try:
        client = MongoClient(args.mongo_uri)
        db = client[args.db_name]
        collection = db[args.collection]

        if args.drop_first:
            LOG.warning("Dropping collection '%s' before import", args.collection)
            collection.drop()

        total_inserted = 0
        total_duplicates = 0
        total_errors = 0

        t0 = time.time()
        for idx, file_path in enumerate(files, start=1):
            LOG.info("[%s/%s] Importing %s", idx, len(files), os.path.basename(file_path))
            docs = read_dump_file(file_path)
            if not docs:
                LOG.info("%s contained 0 documents; skipping", os.path.basename(file_path))
                continue

            inserted, dupes, errs = insert_documents(
                collection, docs, continue_on_error=bool(args.continue_on_error)
            )
            total_inserted += inserted
            total_duplicates += dupes
            total_errors += errs
            LOG.info(
                "Imported file: %s | inserted=%s, duplicates=%s, other_errors=%s",
                os.path.basename(file_path),
                inserted,
                dupes,
                errs,
            )

        elapsed_ms = int((time.time() - t0) * 1000)
        LOG.info(
            "Completed import of %s files: inserted=%s, duplicates=%s, other_errors=%s in %sms",
            len(files),
            total_inserted,
            total_duplicates,
            total_errors,
            elapsed_ms,
        )

        # Print a machine-readable summary
        print(
            {
                "ok": True,
                "files_processed": len(files),
                "inserted": total_inserted,
                "duplicates": total_duplicates,
                "other_errors": total_errors,
                "db": args.db_name,
                "collection": args.collection,
            }
        )

    except (PyMongoError, RuntimeError, ValueError) as e:
        print(f"Import error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()


