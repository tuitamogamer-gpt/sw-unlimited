#!/usr/bin/env python3
"""Rebuild starter decks from reviewed recipes and cached SWU-DB card data.

No network is required by default. --refresh replaces the API snapshots first.
This intentionally fails on card identity changes rather than guessing a match.
"""
import argparse
import collections
import hashlib
import json
import pathlib
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
DATA = ROOT / "data"


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true", help="Download current API snapshots")
    args = parser.parse_args()
    manifest = json.loads((DATA / "starter-recipes.json").read_text())
    cards, images, backs, snapshots = {}, {}, {}, []
    for set_code in manifest["sets"]:
        path = DATA / "card-api" / f"{set_code}.json"
        url = manifest["api"].replace("{set}", set_code)
        if args.refresh:
            request = urllib.request.Request(url, headers={"User-Agent": "SWU-Solo-Deck-Importer/1.0"})
            payload = urllib.request.urlopen(request, timeout=45).read()
            parsed = json.loads(payload)
            if not parsed.get("data"):
                raise ValueError(f"Empty card response: {url}")
            path.write_bytes(payload)
    # The app now has a full card catalog. Rebuilding starter recipes must not
    # discard images from non-starter sets or promotional printing aliases.
    for path in sorted((DATA / "card-api").glob("*.json")):
        parsed = json.loads(path.read_bytes())
        if not isinstance(parsed, dict) or not isinstance(parsed.get("data"), list):
            continue
        set_code = path.stem
        url = manifest["api"].replace("{set}", set_code)
        raw = path.read_bytes()
        records = parsed["data"]
        snapshots.append({"set": set_code.upper(), "url": url, "records": len(records), "sha256": hashlib.sha256(raw).hexdigest()})
        for card in records:
            code = f'{card["Set"]}_{card["Number"].zfill(3)}'
            raw_code = f'{card["Set"]}_{card["Number"]}'
            if card.get("FrontArt"):
                images[code] = card["FrontArt"]
                images[raw_code] = card["FrontArt"]
            if card.get("BackArt"):
                backs[code] = card["BackArt"]
            if card.get("VariantType") == "Normal":
                cards[code] = card

    def enrich(entry, expected_type=None):
        card = cards[entry["id"]]
        assert card["Name"].strip() == entry["name"].strip(), f'Name changed: {entry["id"]}'
        assert card.get("cid") == entry["cid"], f'Official identity changed: {entry["id"]}'
        if expected_type:
            assert card["Type"] == expected_type, f'Wrong type: {entry["id"]}'
        else:
            assert card["Type"] in ("Unit", "Event", "Upgrade"), f'Illegal main-deck card: {entry["id"]}'
        return {**entry, "name": card["Name"], "subtitle": card.get("Subtitle", ""), "image": card.get("FrontArt")}

    decks = []
    for recipe in manifest["decks"]:
        deck = {**recipe, "leader": enrich(recipe["leader"], "Leader"), "base": enrich(recipe["base"], "Base"), "deck": [enrich(c) for c in recipe["deck"]]}
        assert sum(c["count"] for c in deck["deck"]) == 50, f'Wrong deck size: {deck["id"]}'
        counts = collections.Counter()
        for card in deck["deck"]:
            assert isinstance(card["count"], int) and 1 <= card["count"] <= 3
            counts[(card["name"], card["subtitle"])] += card["count"]
        assert max(counts.values()) <= 3, f'More than three copies: {deck["id"]}'
        assert len({c["id"] for c in deck["deck"]}) == len(deck["deck"])
        if deck.get("baseHealth"):
            assert int(cards[deck["base"]["id"]]["HP"]) == deck["baseHealth"]
        decks.append(deck)
    assert len({d["id"] for d in decks}) == len(decks)
    write_json(DATA / "decks.json", decks)
    write_json(DATA / "card-images.json", dict(sorted(images.items())))
    write_json(DATA / "card-back-images.json", dict(sorted(backs.items())))
    write_json(DATA / "card-api-provenance.json", {"retrievedAt": manifest["retrievedAt"], "snapshots": snapshots})
    print(f"Validated and rebuilt {len(decks)} decks, {len(cards)} normal card records, {len(images)} image aliases.")


if __name__ == "__main__":
    main()
