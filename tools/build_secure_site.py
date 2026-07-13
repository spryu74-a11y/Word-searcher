"""Build a least-privilege static asset set for edge hosting."""
from __future__ import annotations

import argparse
import shutil
from pathlib import Path

MAX_ASSET_BYTES = 25 * 1024 * 1024
ROOT = Path(__file__).resolve().parents[1]
FILES = (
    "index.html", "app.js", "search-worker.js", "styles.css",
    "data/default-dictionary.js", "data/default-dictionary.txt",
    "data/default-dictionary-meta.json", "data/search-index-manifest.json",
    "assets/alternative-one-shot-profile.png", "assets/blunder-profile.png",
    "assets/general-word-profile.png", "assets/one-shot-profile.png",
    "assets/back-to-top.png", "assets/fonts/NanumGothic.woff",
    "assets/fonts/NanumGothic.clean.ttf",
)


def copy_file(source: Path, destination: Path) -> None:
    if not source.is_file() or source.is_symlink():
        raise SystemExit(f"required asset is missing or unsafe: {source}")
    if source.stat().st_size > MAX_ASSET_BYTES:
        raise SystemExit(f"asset exceeds Cloudflare's 25 MiB limit: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=ROOT / "cloudflare" / "dist")
    parser.add_argument("--check", action="store_true", help="kept for CI compatibility; build performs all checks")
    args = parser.parse_args()
    output = args.output.resolve()
    if output == ROOT or ROOT not in output.parents:
        raise SystemExit("output must be a child of this repository")
    safe_rebuild_outputs = {ROOT / "dist", ROOT / "cloudflare" / "dist"}
    if output.exists() and output not in safe_rebuild_outputs:
        raise SystemExit("refusing to delete an existing path outside the disposable dist directories")
    if output.exists():
        shutil.rmtree(output)
    for relative in FILES:
        copy_file(ROOT / relative, output / relative)
    for source in sorted((ROOT / "data" / "search-index-shards").glob("*.json")):
        copy_file(source, output / "data" / "search-index-shards" / source.name)
    print(f"built {sum(1 for _ in output.rglob('*') if _.is_file())} safe assets in {output}")


if __name__ == "__main__":
    main()
