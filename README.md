# Star Wars Unlimited · Command

Browser igra za jednog igrača protiv taktičkog AI protivnika, s automatiziranim
Star Wars: Unlimited pravilima i službenim starter / Spotlight špilovima.
Sučelje je na hrvatskom; nazivi karata i odluke enginea koriste izvorni engleski.

Uvezeno je **18 špilova**, svaki s 50 glavnih karata, vođom i bazom:

| Proizvod | Vođe |
| --- | --- |
| Spark of Rebellion | Luke Skywalker, Darth Vader |
| Shadows of the Galaxy | The Mandalorian, Moff Gideon |
| Twilight of the Republic | Ahsoka Tano, General Grievous |
| Jump to Lightspeed | Boba Fett, Han Solo |
| Legends of the Force | Qui-Gon Jinn, Darth Maul |
| Secrets of Power | Padmé Amidala, Chancellor Palpatine |
| A Lawless Time | Leia Organa, Jabba the Hutt |
| Ashes of Empire | Luke Skywalker, Emperor Palpatine |
| Intro Battle: Hoth | Leia Organa, Darth Vader — baze 20 HP |

## Pokretanje

Potreban je Node.js 22 ili noviji (provjereno na Node.js 24).

```sh
npm ci
npm run engine:setup
npm run dev
```

Otvori `http://localhost:5173`. Vite prosljeđuje API zahtjeve Node poslužitelju
na portu 3001. Za jedan produkcijski proces:

```sh
npm run build
npm start
```

Otvori `http://localhost:3001`. Varijable `PORT` i `HOST` mogu promijeniti adresu.
Alternativno: `docker build -t swu-command .` pa
`docker run --rm -p 3001:3001 swu-command`.

## Igra

Odaberi svoj špil, protivnički špil i težinu. Engine vodi mulligan, početna dva
resursa, naizmjenične akcije, mete, okidanja, borbu u kopnenoj i svemirskoj areni,
vođe, inicijativu i regroup. Označene karte i gumbi predstavljaju legalne izbore.
Povećani prikaz omogućuje čitanje karata, a dnevnik prati razrješenje efekata.

AI koristi isti legalni sustav akcija. Procjenjuje završne napade, obranu baze,
razmjenu jedinica, Sentinel, štitove, resursnu krivulju, deployment i inicijativu.
Prima samo svoju ruku i javno stanje. Nema pristup protivničkoj ruci, redoslijedu
špila ni shuffle seedu. Detalji: [docs/ai.md](docs/ai.md).

## Pravila i podaci

Pravila i skripte karata izvršava MIT engine
[Forceteki](https://github.com/SWU-Karabast/forceteki), uključen u repozitorij
na fiksnom commitu. Aplikacija odbija špil ako ijedna njegova karta nema
implementaciju u tom engineu. Provjera pokrivenosti nije tvrdnja da svi mogući
međusobni efekti nemaju grešaka.

Uključena je dokumentirana ispravka za grupno razrješenje Advantage okidača,
s regresijskim testom: [docs/upstream-patches.md](docs/upstream-patches.md).

Definicije karata su lokalni snapshot; partija ne ovisi o dostupnosti API-ja.
Slike se učitavaju s CDN-a. Izvori, službeni pravilnik, errate i odvojeno označena
Reddit / BoardGameGeek tumačenja: [docs/rules-and-sources.md](docs/rules-and-sources.md).
Verzijska granica pravilnika i implementiranih ponašanja:
[docs/rules-version.md](docs/rules-version.md).

## Provjere

```sh
npm test
npm run test:smoke
npm run cards:check
npm run build
```

Testovi provjeravaju stvarne partije i granicu privatnih informacija te odbijanje
nelegalnih akcija. Upstream također uključuje vlastite detaljne testove pravila
u `vendor/forceteki/test`.

## Granice ove verzije

Partije se čuvaju u memoriji Node procesa do šest sati neaktivnosti. Osvježavanje
preglednika može nastaviti postojeću sesiju; restart poslužitelja je prekida.
Ovaj poslužitelj namijenjen je osobnom/local hostingu, bez korisničkih računa.
Za trajni javni servis potrebni su trajna pohrana i upravljanje korisničkim sesijama.
AI je lokalni taktički sustav, bez LLM poziva ili API ključa.

Podržan je 1v1 Premier. Twin Suns koristi drugačiji multiplayer format.
Detalji uključenih proizvoda i izvori popisa: [docs/deck-data.md](docs/deck-data.md).

Neslužbeni fan projekt. Licence i zasluge:
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
