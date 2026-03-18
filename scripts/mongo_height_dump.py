import argparse
import json
import os
import sys
from datetime import datetime
import logging
import time

from pymongo import MongoClient
from pymongo.errors import PyMongoError
from bson.json_util import dumps as bson_dumps


LOG = logging.getLogger("mongo-height-dump")


def parse_args():
    parser = argparse.ArgumentParser(
        description="Dump MongoDB documents from a collection by height ranges into JSON files."
    )
    parser.add_argument(
        "--mongo-uri",
        required=True,
        help="MongoDB connection string URI (e.g., mongodb://user:pass@host:27017/dbname)",
    )
    parser.add_argument(
        "--collection",
        default="mining_notify",
        help="Collection name to dump (default: mining_notify)",
    )
    parser.add_argument(
        "--db-name",
        default="stratum-logger",
        help="MongoDB database name (default: stratum-logger)",
    )
    parser.add_argument(
        "--start-height",
        type=int,
        required=True,
        help="Starting block height to begin dumping from.",
    )
    parser.add_argument(
        "--chunk-size",
        type=int,
        required=True,
        help="Number of heights per chunk to include in each JSON output file.",
    )
    parser.add_argument(
        "--backup-dir",
        required=True,
        help="Directory where JSON dump files will be written.",
    )
    parser.add_argument(
        "--end-height",
        type=int,
        default=None,
        help="Optional inclusive end height. If omitted, will continue until min/max in collection depending on direction.",
    )
    parser.add_argument(
        "--descending",
        action="store_true",
        help="Walk heights downward (start -> smaller heights). Default is ascending.",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Write pretty-printed JSON (larger files).",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"],
        help="Logging level (default: INFO)",
    )
    return parser.parse_args()


def ensure_backup_dir(path: str) -> None:
    os.makedirs(path, exist_ok=True)


def get_collection_bounds(collection):
    height_filter = {"height": {"$exists": True, "$type": "number"}}
    doc_min = (
        collection.find(height_filter, {"_id": 0, "height": 1}).sort([("height", 1)]).limit(1)
    )
    doc_max = (
        collection.find(height_filter, {"_id": 0, "height": 1}).sort([("height", -1)]).limit(1)
    )
    min_height = None
    max_height = None
    for d in doc_min:
        min_height = d.get("height")
    for d in doc_max:
        max_height = d.get("height")
    return min_height, max_height


def build_filename(dir_path: str, low: int, high: int) -> str:
    return os.path.join(dir_path, f"{high}-{low}.json")


def dump_range(collection, low: int, high: int, outfile: str, pretty: bool = False) -> int:
    query = {"height": {"$gte": low, "$lte": high}}
    LOG.info("Querying documents for heights [%s..%s]", low, high)
    t0 = time.time()
    cursor = collection.find(query).sort([("height", 1), ("timestamp", 1)])
    docs = list(cursor)
    fetch_ms = int((time.time() - t0) * 1000)
    LOG.info("Fetched %s documents for [%s..%s] in %sms", len(docs), low, high, fetch_ms)
    # Use Extended JSON to preserve BSON types (ObjectId, datetime, etc.) for reliable restore/migration
    if pretty:
        data = bson_dumps(docs, indent=2)
    else:
        data = bson_dumps(docs)
    LOG.info("Writing %s documents to %s", len(docs), outfile)
    t1 = time.time()
    with open(outfile, "w", encoding="utf-8") as f:
        f.write(data)
    write_ms = int((time.time() - t1) * 1000)
    LOG.info("Wrote %s in %sms for chunk [%s..%s]", os.path.basename(outfile), write_ms, low, high)
    return len(docs)


def main():
    args = parse_args()

    # Configure logging
    log_level = getattr(logging, args.log_level.upper(), logging.INFO)
    logging.basicConfig(
        stream=sys.stdout,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        level=log_level,
    )

    if args.chunk_size <= 0:
        print("--chunk-size must be positive", file=sys.stderr)
        sys.exit(2)
    if args.start_height < 0:
        print("--start-height must be non-negative", file=sys.stderr)
        sys.exit(2)

    ensure_backup_dir(args.backup_dir)

    try:
        LOG.info("Connecting to MongoDB and selecting db '%s', collection '%s'", args.db_name, args.collection)
        client = MongoClient(args.mongo_uri)
        db = client[args.db_name]
        collection = db[args.collection]

        min_h, max_h = get_collection_bounds(collection)
        if min_h is None or max_h is None:
            total = collection.estimated_document_count()
            with_height = collection.count_documents({"height": {"$exists": True}})
            print(
                (
                    "Collection appears empty or lacks 'height' field. "
                    f"total_docs={total}, docs_with_height={with_height}"
                ),
                file=sys.stderr,
            )
            sys.exit(1)
        LOG.info("Collection bounds discovered: min_height=%s, max_height=%s", min_h, max_h)

        descending = bool(args.descending)
        LOG.info("Traversal direction: %s", "descending" if descending else "ascending")

        # Determine traversal bounds
        if descending:
            current = args.start_height
            lower_bound = args.end_height if args.end_height is not None else min_h
            if current < lower_bound:
                print("start-height is below available lower bound.", file=sys.stderr)
                sys.exit(2)
        else:
            current = args.start_height
            upper_bound = args.end_height if args.end_height is not None else max_h
            if current > upper_bound:
                print("start-height is above available upper bound.", file=sys.stderr)
                sys.exit(2)

        total_docs = 0
        total_files = 0

        while True:
            if descending:
                high = current
                low = max(min_h, current - args.chunk_size + 1)
                if args.end_height is not None:
                    low = max(low, args.end_height)
                if low > high:
                    break
            else:
                low = current
                high = min(max_h, current + args.chunk_size - 1)
                if args.end_height is not None:
                    high = min(high, args.end_height)
                if high < low:
                    break

            outfile = build_filename(args.backup_dir, low, high)
            LOG.info("Processing chunk [%s..%s] => %s", low, high, outfile)
            count = dump_range(collection, low, high, outfile, pretty=args.pretty)
            total_docs += count
            total_files += 1

            # Move to next window
            if descending:
                next_current = low - 1
                if args.end_height is not None and next_current < args.end_height:
                    break
                if next_current < min_h:
                    break
                current = next_current
            else:
                next_current = high + 1
                if args.end_height is not None and next_current > args.end_height:
                    break
                if next_current > max_h:
                    break
                current = next_current

        print(
            json.dumps(
                {
                    "ok": True,
                    "files_written": total_files,
                    "documents_dumped": total_docs,
                    "direction": "desc" if descending else "asc",
                    "backup_dir": os.path.abspath(args.backup_dir),
                },
                indent=2,
            )
        )

    except PyMongoError as e:
        print(f"Mongo error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()


