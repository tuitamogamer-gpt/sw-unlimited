# Osnova iz postojećih projekata

Pregledano 8. listopada 2026. Sva četiri javna repozitorija nalaze se lokalno u `/workspace/references/`, klonirana s `--depth 1 --filter=blob:none` i sparse checkoutom za `src`, `tests`, `docs`, `scripts` te korijenske datoteke. Veliki `public` slikovni i video direktoriji nisu preuzeti. Reference nisu mijenjane.

| Projekt | Pregledani commit | Korisna osnova |
| --- | --- | --- |
| [riftbound-duel-lab](https://github.com/tuitamogamer-gpt/riftbound-duel-lab) | `c4699f9c8a39d1243635ba56f9eee23a2869c671` | Najbliži 1v1 model: odvojeni rules engine, AI promatranje i pretraga, legalne akcije, React stol, starter liste i coverage audit. |
| [mtg-commander-simulator](https://github.com/tuitamogamer-gpt/mtg-commander-simulator) | `38a1d953f185f122c9b6e7720e4ecaf92bc92b5e` | Slojevit lokalni AI, deck profili, različiti stilovi, procjena prijetnji, taktičko pretraživanje i objašnjenja odluka. |
| [lotrlcg](https://github.com/tuitamogamer-gpt/lotrlcg) | `b6926c36ca587fc204a9264da99cc4a307920cb2` | Provjerene službene starter liste, slikovni odabir deckova, javni zapis događaja, pregled efekata i siguran nastavak spremljene igre. |
| [marvel-lcg](https://github.com/tuitamogamer-gpt/marvel-lcg) | `90ce3e76fcfe908e48788b58e86a379d11bd11f9` | Serijalizirani red efekata, eksplicitni izbori igrača, ownership/control razdvajanje, semantički pregled rezultata svake akcije. |

Nema korijenskih niti relevantnih `src`/`tests` AGENTS.md u ova četiri checkouta. Marvel ima `motion/milestones/AGENTS.md` izvan pregledanog/opsega preuzimanja.

## Preporučeni SWU model

Nova mala React/TypeScript/Vite aplikacija s vlastitim SWU rules engineom. Preuzeti obrasce, a ne preslikati pravila druge igre: Riftbound ima stack, reakcije i osvajanje battlefieldeova koji nisu SWU redoslijed akcija. MTG i cooperative LCG enginei još su dalje od SWU semantike. Novi SWU runtime treba jedan autoritativni put `legalActions(state, player)` → `applyAction(state, action)` za čovjeka, bota, testove i simulaciju.

- Seedano miješanje i potpuna serijalizacija stanja. Fizička instanca karte treba jedinstveni ID različit od kataloškog ID-a.
- Red efekata i eksplicitan pending choice za cilj, redoslijed trigera, opcionalni efekt, mulligan i resource izbor. Sučelje ne provodi pravila.
- Odvojena ground/space arena, leader zona i base; posebne zastavice za claim initiative i pass. Nemojte prilagođavati Riftbound stack kao SWU mehanizam.
- Odvojena pravila i prezentacija: AI može brzo izračunati potez, a UI prikazuje njegov javni rezultat. Pauza/pregled ne smije drugi put izvršiti potez.
- Katalog i automatizacija nisu isto. Svaka uvezena karta treba status; nepokrivenu cijelu klauzulu ne smije zamijeniti keyword-only skripta. Starter treba točan main list i zasebne leader/base karte.
- Starter prikaz treba leader art, proizvod/set, deck strategiju, točan broj karata i pregled liste. Sačuvati provenijenciju i razliku između povijesne retail liste i turnirske legalnosti.

## Konkretne datoteke za ponovnu upotrebu/adaptaciju

Sve putanje u tablici relativne su `/workspace/references/`.

| Datoteka | Što konkretno preuzeti |
| --- | --- |
| `riftbound-duel-lab/src/hooks/useBodyScrollLock.ts` | Gotov samostalan hook s referentnim brojanjem za ugniježđene modale; može se prenijeti izravno. |
| `riftbound-duel-lab/src/hooks/useDialogFocus.ts` | Focus trap, Escape, povrat fokusa i detekcija najvišeg modala; prilagoditi CSS selektore novom UI-ju. |
| `riftbound-duel-lab/src/hooks/useBotDecision.ts` | Lazy module Worker, observation/request ID, odbacivanje starih odgovora, validation prije izvršenja, 5 s watchdog, već pripremljen legalni fallback. |
| `riftbound-duel-lab/src/game/ai/config.ts` | `SearchBudget`, deterministički hash/PRNG, težine i node/depth/width ograničenja po težini. Card profile dio treba SWU roleove. |
| `riftbound-duel-lab/src/game/ai/decisions.ts` | `DecisionRequest`, `BotDecision`, observation version, stabilni ID opcije i provjera legalnosti prije prihvaćanja worker rezultata. |
| `riftbound-duel-lab/src/game/ai/observation.ts` | Koncept `getObservation` i zasebnog pravila-viewa bez protivničke ruke, deck ordera i RNG-a. Stari tipovi i specifične inspekcije nisu prenosivi. |
| `riftbound-duel-lab/src/game/ai/planner.ts` | Kandidat → stvarni resolver → evaluacija → beam; `settleSimulation` rješava obavezne izbore realnim pravilima. Pretragu u SWU vezati za izmjenu akcija. |
| `riftbound-duel-lab/src/game/ai/evaluate.ts` | Razdvojen terminalni ishod, material, resursi i opasnost. U SWU zamijeniti points/hold evaluaciju base damageom, tradeovima, arenama i inicijativom. |
| `riftbound-duel-lab/src/data/card-identity.ts` | Fingerprint cijelog pravila prije dijeljenja skripte među alternate printovima; SWU title + subtitle obvezno sačuvati. |
| `riftbound-duel-lab/src/game/card-registry.ts` | `scripted / compiled / alias / unsupported`, konzervativno sparivanje i razlog za nepokrivene karte. |
| `riftbound-duel-lab/scripts/report-card-coverage.mjs` | Provjera digest-a kataloga, jedinstvenih ID-a, referenci starter lista i izvještaj za svaku pojedinačnu kartu. |
| `riftbound-duel-lab/src/session-storage.ts` | Verzija rules/cataloga, validacija savea, očuvanje prethodnog savea pri grešci i kontrolirani import/export. |
| `riftbound-duel-lab/src/components/CardPreview.tsx` | Hover/focus preview, touch fallback, viewport placement i zabrana otvaranja skrivenih karata. Integracija s katalogom mora se prepisati. |
| `riftbound-duel-lab/src/game/playback.ts` | Brzine 0.5×/1×/2× i čist pregled već snimljenih frameova bez replaya rules akcije. |
| `lotrlcg/src/ui/deck-picker.tsx` | Grupiranje retail startera, kompletan list/details, vidljivi blokirani deck s objašnjenjem, odvojeni custom izbori. |
| `lotrlcg/src/game/presentation.ts` | Javno promatranje before/after stanja, kronika i pauziranje na značajnim događajima. |
| `lotrlcg/src/data/official-starter-decks.json` | Sourced JSON recipe obrazac, nikako SWU sadržaj. |
| `marvel-lcg/src/game/review.ts` | `boardSnapshot`, `isMeaningful`, `recordReview`, spajanje javnih promjena i pace selector. |
| `mtg-commander-simulator/docs/COMMANDER_AI_ENGINE.md` | Jasno dokumentiran pipeline i ograničenja, public knowledge boundary, strategy profile + difficulty + engine legal actions. |
| `mtg-commander-simulator/src/modules/ai-v2.js` | Primjer role/synergy cachea, threat procjene, terminalnog prioriteta i strukture reason/alternatives loga. Datoteka koristi globalni MTG objekt; ne kopirati kao SWU modul. |

## AI koji odgovara traženom opsegu

Bot treba koristiti vlastitu ruku i javni stol, bez protivničke ruke, skrivenih resource identiteta i budućeg redoslijeda bilo kojeg decka. Za startere može poznavati objavljeni sastav decka kao javnu prior distribuciju, ali ne točnu preostalu ruku. Deterministički hidden-information test mora zamijeniti tajne karte i redoslijed te dobiti istu javnu opažajnu strukturu i odluku.

SWU evaluacija treba najmanje:

1. Neposrednu pobjedu i sprečavanje vidljivog lethal-a kao dominantne kriterije.
2. Base pressure, board power/HP, ready/exhausted stanje i trade vrijednost po areni.
3. Sentinel otvaranje/probijanje, Shield i Restore, te leader deploy timing.
4. Zadržavanje odgovarajuće karte u ruci za sljedeći resource prag; resource izbor nije nasumično odbacivanje.
5. Initiative value: ocijeniti redoslijed najboljeg sljedećeg napada i cijenu prerano preskočenih akcija.
6. Strategiju izvedenu iz stvarnog startera: aggro, tempo, control, upgrade, token ili vehicle/pilot prioriteti prema podržanom setu.
7. Obrazloženje i 2–3 razmotrene alternative; timeout mora dati legalnu odluku i nastaviti igru.

Riftbound predložak težina ima beginner 180 čvorova / depth 1, normal 480 / depth 2, hard 1100 / depth 3 i expert 2200 / depth 4. To su početne referentne vrijednosti, ne dokaz SWU snage; profile i budget treba mjeriti na SWU scenarijima.

## Korisni testovi iz referenci

- `riftbound-duel-lab/tests/ai-authorized-knowledge.test.ts`: dopuštene reveal/inspection granice.
- `riftbound-duel-lab/tests/ai-acceptance.test.ts`, `ai-profiles.test.ts`, `ai-prepared-fallback.test.ts`: taktika, profili i oporavak.
- `riftbound-duel-lab/tests/precon-integration.test.ts`, `precon-effects.test.ts`, `precon-timing.test.ts`: svaki starter i njegove stvarne skripte kroz engine.
- `riftbound-duel-lab/tests/session-storage.test.ts`, `persistence.test.ts`: reload i neispravan save.
- `riftbound-duel-lab/tests/card-registry.test.ts`, `card-script-compiler.test.ts`: imported != supported, alias samo pri identičnoj rules face.
- `mtg-commander-simulator/tests/ai-v2.test.mjs`: determinističko odlučivanje i privatnost.

Najvažniji SWU acceptance gate: svi ugrađeni starteri imaju točne liste i eksplicitno potpunu automatizaciju; oba smjera svakog para mogu završiti seedanu igru bez illegal actiona/stalla; taktički scenariji potvrđuju base lethal, Sentinel, Shield, initiative, leader deployment, trajanje modificiranih statova, defeat triggere i compulsory/optional izbore. Za svaki dodatni starter mehanizam treba specifičan test prije oznake full scripted.
