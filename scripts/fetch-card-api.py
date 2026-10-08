#!/usr/bin/env python3
"""Refresh every set advertised by the public SWU-DB API, including promos.

Raw replies are stored unmodified. Empty advertised sets are retained as empty
snapshots and reported; they must not be mistaken for complete card inventory.
"""
import concurrent.futures
import datetime
import hashlib
import json
import pathlib
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "card-api"
OUT.mkdir(parents=True, exist_ok=True)


def fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": "SWU-Solo-Card-Catalog/1.0"})
    with urllib.request.urlopen(request, timeout=45) as response:
        raw = response.read(32 * 1024 * 1024)
    return raw


def fetch_set(info):
    code = info["setId"].lower()
    url = f"https://api.swu-db.com/cards/{code}"
    raw = fetch(url)
    response = json.loads(raw)
    if not isinstance(response.get("data"), list):
        raise ValueError(f"Unexpected response from {url}")
    (OUT / f"{code}.json").write_bytes(raw)
    count = len(response["data"])
    print(f"{code.upper()}: {count} printings" + (" (advertised set returned no data)" if not count else ""))
    return {"set": code.upper(), "url": url, "count": count, "sha256": hashlib.sha256(raw).hexdigest()}


def main():
    raw = fetch("https://api.swu-db.com/sets")
    sets = json.loads(raw)
    if not isinstance(sets, list) or not sets:
        raise ValueError("Invalid or empty set catalog")
    (OUT / "sets.json").write_bytes(raw)
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        snapshots = list(pool.map(fetch_set, sets))
    (ROOT / "data" / "card-api-fetch.json").write_text(json.dumps({
        "fetchedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "setsUrl": "https://api.swu-db.com/sets",
        "snapshots": snapshots,
    }, indent=2) + "\n")


if __name__ == "__main__":
    main()
