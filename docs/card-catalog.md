# Full card inventory, aliases and engine coverage

The catalog is reproducible from the checked-in API snapshots and the pinned Forceteki build. Its research cutoff is **2026-10-08**. Importing a card record does not implement its rules.

## Current scope

| Count | Meaning |
| --- | --- |
| 51 | Sets advertised by `https://api.swu-db.com/sets`, including promo products |
| 10,157 | Actual API printing records downloaded across those sets |
| 2,600 | Normal set-code records in the browser, including reprints and tokens |
| 2,579 | Browser records with complete engine data and implemented rules |
| 21 | Provisional IC27 records unavailable for games |
| 2,479 | Distinct engine identities, counted once across all reprints |
| 2,458 | Distinct identities with complete data and implemented rules, including tokens |
| 2,071 | Registered card implementation classes |
| 408 | Engine identities handled by generic keyword/vanilla behavior |
| 10,845 | Accepted card-code aliases, including unpadded and alternate-art codes |

The browser has one entry for each normal set-code printing; cosmetic foil, hyperspace, showcase and promo versions attach to that entry as aliases and `printings`. Reprints across expansions remain separate browser entries, but their `engineId` is identical. The deck importer must count copies by `engineId`, not by the supplied printing code. Tokens are present for reference with `deckEligible:false`.

**Coverage is the installed engine's declared implementation coverage, not a claim that every card has been exhaustively tested.** Native `isImplemented` is evaluated from the actual compiled registry and `Card.checkHasNonKeywordAbilityText`. Generic cards require no bespoke implementation file. The report separately tracks data completeness so a compiled class cannot turn placeholder metadata into a playable card.

All 51 advertised endpoints were fetched. The `SOROPJ` endpoint currently returns zero records despite advertising two; that source limitation is preserved in the snapshot report. A downloaded inventory cannot prove the API has every published promotional printing.

## Release and preview distinctions

The source set catalog lists Homeworlds (`HMW`) for **2026-10-09** and Icons 2027 (`IC27`) for **2026-11-20**, both after this inventory's cutoff. Every row and set has separate `releaseStatus`, `releaseDate`, and `preview` fields. HMW has complete installed engine definitions and is available as explicitly labeled preview data. Availability does not assert tournament legality or a completed official release.

IC27 contains **21 synthetic engine IDs**, including **19 definitions with mock rules text**. All 21 are `engineSupported:false`, `engineStatus:'missing-data'`, and `dataCompleteness:'provisional'`, even though the compiled native registry recognizes them. Nine have a real API image; missing preview pictures remain null. They can be browsed but must be rejected for game creation. Synthetic identities and mock text are never replaced with guessed card rules.

The catalog includes the individual `TS26` card identities and their implementations. This does not enable the Twin Suns multiplayer format or import its two-leader preconstructed decks into 1v1.

## Rebuild and refresh

```sh
npm run engine:setup                  # If the pinned engine is not built yet
node scripts/sync-card-catalog.cjs    # Entirely offline rebuild
node scripts/report-card-catalog.cjs # Inspect counts, missing data and aliases
node scripts/sync-card-catalog.cjs --check # Read-only artifact reproducibility check
node --test tests/card-inventory.test.cjs

# Explicit online refresh of the set catalog and every advertised endpoint:
node scripts/sync-card-catalog.cjs --refresh

# Recompute release/preview labels for a different inventory cutoff:
node scripts/sync-card-catalog.cjs --as-of 2026-10-09
```

`scripts/fetch-card-api.py` uses Python's standard library and saves the unmodified API replies. `--refresh` invokes it before rebuilding. Refreshing data alone does not add new Forceteki implementations; any new or unresolved normal identity appears unavailable. A future engine update requires rebuilding and auditing the registry again.

The starter importer also reads every available snapshot when rebuilding image maps, so `scripts/sync-decks.py` preserves the full card pool. Run the catalog importer after a data refresh to update aliases and coverage. The generated JSON is checked in so production requests need no remote card API connection.

## Files and contract

- `data/card-catalog.json`: browser records and summary, pinned engine commit/data version/hash, and inventory cutoff.
- `data/card-aliases.json`: `byCode` and `byId` lookups. Values have `{code,engineCode,engineId,engineSupported,deckEligible}`. `engineCode` is a real key accepted by native `Deck`; arbitrary image/foil/promo codes must be normalized through this map first.
- `data/card-coverage.json`: API snapshot SHA-256 hashes, counts, unavailable rows, unresolved printing records and alias conflicts.
- `data/card-alias-overrides.json`: small reviewed exceptions with evidence URLs and expected source identity, applied before generic identity matching.
- `data/card-api/*.json`: all 51 original set responses and the original set catalog.
- `data/card-images.json`, `data/card-back-images.json`: exact URLs returned by the API, including every downloaded printing. No URL is synthesized for a missing picture.

Normal rows expose `code`, canonical `id`/`engineId`, `engineCode`, `internalName`, name/subtitle, types, aspects, traits, keywords, stats, rules text, image URLs, `aliases`, `idAliases`, and printing details. The engine's fields are authoritative when API spelling or preview text differs; original divergent API names are retained in `apiName`/`apiSubtitle`.

`engineStatus` is `scripted`, `missing-script`, or `missing-data`. `implementationType` distinguishes `scripted` from `generic` even when both are usable. `nativeImplemented` reports the raw compiled-engine predicate; `engineSupported` additionally requires complete nonsynthetic metadata. Consumers should use `engineSupported` for game availability and `deckEligible` for whether an entry can occupy a leader/base/main-deck slot.

## Identity normalization and evidence

The resolver first uses a native set-code alias, then an exact official ID, then a unique name/subtitle/type identity anchored to a known normal printing. It does not infer a card from a similar name. Base location subtitles are not game identity; leaders and units remain distinguished by type and subtitle. A detected conflicting alias causes the generator to fail and records the conflict for review.

Two promotional records, `P25_019` and `P25_020`, were published by the API with **Darth Revan's Lightsaber** in the singular. Their actual [participation card image](https://cdn.swu-db.com/images/cards/P25/19.png) and [judge card image](https://cdn.swu-db.com/images/cards/P25/20.png) were inspected and both say **Darth Revan's Lightsabers**, matching `LOF_238`, its cost, aspects, stats and complete rules text. These two specific identity corrections are recorded in the reviewed override file; the importer checks their official source IDs before applying them. The resulting inventory has zero unresolved downloaded printings and zero alias conflicts.

## SWUDB deck exports

The bundled upstream `server/utils/deck/SwuDbDeckFetcher.ts` documents and implements the public export endpoint:

```text
GET https://swudb.com/api/getDeckJson/{deckId}
```

Its response uses `metadata:{name,author}`, `leader:{id}`, `base:{id}`, `deck:[{id,count}]`, optional `sideboard`, and optional `secondleader`. Typical card identifiers are `SOR_005`. This deck service at **swudb.com** is distinct from the card-data API at **api.swu-db.com**.

Two direct read-only probes of public shared-deck URLs returned HTTP 403 from this execution environment. That establishes an access limitation here, not proof that those decks are private. JSON paste/upload remains the reliable fallback if online export is unavailable. Import code should validate the fixed host/path and bounded JSON response rather than fetching arbitrary pasted URLs.
