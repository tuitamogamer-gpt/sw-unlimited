# Starter deck inventory and reproducible imports

Research date: **8 October 2026**. The application includes **18 complete 1v1 decks**: two each from Spark of Rebellion (SOR), Shadows of the Galaxy (SHD), Twilight of the Republic (TWI), Jump to Lightspeed (JTL), Legends of the Force (LOF), Secrets of Power (SEC), A Lawless Time (LAW), Ashes of the Empire (ASH), and Intro Battle: Hoth (IBH). Every list contains exactly one leader, one base and 50 main-deck cards; maximum three copies of a name/subtitle combination.

Twin Suns preconstructed products are excluded because they use two leaders and multiplayer rules. Homeworlds was presented as a preview set at research time and is not included in the released starter inventory.

## Data files and rebuilding

`data/starter-recipes.json` is the reviewed recipe manifest. Every card retains its set/number, official ten-digit `cid`, expected name, and quantity. Each deck includes source links, product identity, playstyle, verification description, and the archived source location where available.

`data/card-api/*.json` contains the unmodified JSON snapshots downloaded from the community [SWU-DB card API](https://api.swu-db.com/cards/sor). The practical bulk endpoint is `https://api.swu-db.com/cards/{set}`, where `{set}` is a lowercase expansion code. The response has `total_cards` and a `data` array with card text, stats, traits, aspects, keyword tags, official `cid`, and `FrontArt`/`BackArt` image URLs. These bulk records include alternate printings; the importer selects `VariantType: Normal` for recipe identities.

Run from the project root:

```sh
python scripts/sync-decks.py           # Rebuild offline using checked-in snapshots
python scripts/sync-decks.py --refresh # Explicitly refresh all API snapshots first
```

The script regenerates `data/decks.json`, `data/card-images.json`, `data/card-back-images.json`, and the SHA-256 snapshot manifest `data/card-api-provenance.json`. It checks leader/base/card types, all names and official identities, 50-card totals, duplicate entries, and maximum copy counts. A changed identity fails the import for review instead of silently substituting another card. Normal game execution does not require access to the API.

The image maps use actual returned URLs rather than fabricated CDN paths. IBH's API numbers are unpadded; normalized recipe IDs use `IBH_001`, and the image map includes both padded and raw aliases. Card pictures and names remain the property of their respective rights holders; the API is a community database, not an official Fantasy Flight Games service.

## Sources and transcription

| Product | Source | Archived source |
| --- | --- | --- |
| SOR Luke / Vader | [FFG launch article](https://starwarsunlimited.com/articles/launch-sequence), [Luke list](https://sw-unlimited-db.com/decks/3080), [second Luke list](https://sw-unlimited-db.com/decks/59911), [Vader list](https://sw-unlimited-db.com/decks/3081) | `docs/sources/sor-luke.md`, `sor-vader.md` |
| SHD Moff Gideon / Mandalorian | [FFG Heated Rivals](https://starwarsunlimited.com/articles/heated-rivals) | `docs/sources/shd-decklists.png` |
| TWI Ahsoka / Grievous | [FFG Clash of Ideals](https://starwarsunlimited.com/articles/clash-of-ideals) | `docs/sources/twi-decklists.jpg` |
| JTL Boba Fett / Han Solo | [FFG Disintegrating the Odds](https://starwarsunlimited.com/articles/disintegrating-the-odds) | `docs/sources/jtl-decklists.jpg` |
| LOF Qui-Gon / Darth Maul | [FFG A Fated Duel](https://starwarsunlimited.com/articles/a-fated-duel) | `docs/sources/lof-decklists.png` |
| SEC Padmé / Chancellor Palpatine | [FFG Disclosing Plots](https://starwarsunlimited.com/articles/disclosing-plots) | `docs/sources/sec-decklists.png` |
| LAW Leia / Jabba | [FFG Aspects and Credits](https://starwarsunlimited.com/articles/aspects-and-credits) | `docs/sources/law-decklists.png` |
| ASH Emperor Palpatine / Luke | [FFG A Fated Confrontation](https://starwarsunlimited.com/articles/a-fated-confrontation) | `docs/sources/ash-decklists.png` |
| IBH Leia / Vader | [Official product](https://starwarsunlimited.com/products/intro-battle-hoth), [numbered card inventory](https://api.swu-db.com/cards/ibh), [independent full lists](https://lasergamingshop.com/2025/10/26/learn-to-play-star-wars-unlimited-with-intro-battle-hoth/) | `data/card-api/ibh.json` |

For SHD through ASH, the official article's full deck-list image was downloaded, inspected visually, and transcribed. Names, quantities, leader/base identity, and totals were checked against the API. OCR was used only as a reading aid; it is not the importer and is not trusted for card numbers. SOR has a primary product/rules source but its full quantities are independently published community decklists, so its provenance is explicitly different from the archived FFG images. These are the printed product lists, not upgrades or optimized replacements.

## Printed-number discrepancies

Some official preview deck-list images contain numbers that do not correspond to the card named at that number in the current API. The named card is the product's intended identity; the importer records its current verified identity. Examples include:

- LOF Qui-Gon's Ahsoka Tano is printed as previous-set 203; the actual matching card is `JTL_201`, Chasing Whispers.
- SEC Padmé's Seasoned Fleet Admiral and Dogfight are printed as 113 and 125; their actual cards are `JTL_111` and `JTL_123`.
- SEC Chancellor Palpatine's image lists Mas Amedda 85, Sly Moore 32 and Vice Admiral Rampart 84; the matching current identities are `SEC_084`, `SEC_033`, and `SEC_085`.
- LAW Leia's Phoenix Squadron A-Wing and Sabine's Masterpiece are printed as previous-set 097 and 252; their actual identities are `JTL_095` and `JTL_250`.
- LAW Jabba's Contracted Jumpmaster and Contracted Hunter are printed as previous-set 186 and 218; their actual identities are `JTL_184` and `JTL_216`.
- JTL Boba's Jabba's Palace is the previous-set `SHD_026`, not the unrelated SOR card at number 026.

All previous-set cards were matched by both name and available subtitle, not by number alone. The reviewed manifest fixes exact IDs and official `cid` values, preserving these decisions through future API refreshes.

## Intro Battle: Hoth behavior

IBH contains 104 individually numbered physical cards: Leia leader 1, Echo Caverns base 2, her 50 cards 3–52; Vader leader 53, Forward Command Post base 54, his 50 cards 55–104. Repeated physical copies have distinct API IDs. The importer consolidates equivalent name/subtitle copies under their first numbered identity and verifies all quantities against the published independent lists.

The two Hoth decks are clearly labeled **Intro Battle (20 HP)** and preserve the 20-HP base values verified by the API and the rules engine's IBH base tests. They use full shuffled decks, ordinary mulligans, and normal player-chosen resources. They do not reproduce the physical product's fixed opening tutorial. An independent walkthrough describes a 30-HP alternate side; this application deliberately does not apply an unverified alternate card face or mutate the printed engine statistics.

Deck inventory verification does not substitute for rules implementation testing. The adapter's supported-card check and the acceptance/full-game tests establish which scripted engine behaviors are available and exercise the imported decks separately.
