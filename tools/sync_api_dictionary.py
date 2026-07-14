from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FETCHER = ROOT / "tools" / "fetch_stdict_api_words.py"
BUILD_PACK = ROOT / "tools" / "build_dictionary_pack.py"
BUILD_INDEX = ROOT / "tools" / "build_search_index.py"
BUILD_SHARDS = ROOT / "tools" / "build_search_shards.py"
API_KEY_ENV = "STDICT_API_KEY"


def run(script: Path, *arguments: str, env: dict[str, str] | None = None) -> None:
    command = [sys.executable, str(script), *arguments]
    print("+ " + " ".join(command))
    subprocess.run(command, cwd=ROOT, env=env, check=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fetch the Standard Korean Dictionary once, then rebuild the offline search pack."
    )
    parser.add_argument("--key", default=os.environ.get(API_KEY_ENV, ""), help=f"API key. Defaults to ${API_KEY_ENV}.")
    parser.add_argument("--restart", action="store_true", help="Ignore the completed fetch state and fetch again.")
    parser.add_argument("--max-requests", type=int, default=0, help="Testing cap. 0 means fetch all pending prefixes.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    key = str(args.key or "").strip()
    if not key:
        raise SystemExit(f"missing API key: set {API_KEY_ENV} or pass --key")

    env = os.environ.copy()
    env[API_KEY_ENV] = key
    fetch_args: list[str] = []
    if args.restart:
        fetch_args.append("--restart")
    if args.max_requests:
        fetch_args.extend(["--max-requests", str(max(1, args.max_requests))])

    run(FETCHER, *fetch_args, env=env)
    run(BUILD_PACK)
    run(BUILD_INDEX)
    run(BUILD_SHARDS)
    print("API words are now bundled; browser searches use the local index only.")


if __name__ == "__main__":
    main()
