# Provjera implementacije

Provjereno 8. listopada 2026., Node.js 24, lokalni produkcijski build.

- **51/51 aplikacijskih testova**: taktičke odluke, privatnost, legalne i
  zastarjele akcije, atomska validacija raspodjele, kompletne partije i regresije.
- **36/36 dovršenih simuliranih partija**: 18 špilova na dva reproducibilna
  seeda, 4.995 legalnih akcija. Svaki izbor provjerava granicu privatnih podataka
  i da se attachment ne prikazuje kao samostalna jedinica.
- **18/18 špilova**, svaki s 50 glavnih karata. Ukupno 476 različitih
  registriranih ID-ova, uključujući vođe i baze; nema neskriptiranih karata
  u odabranim špilovima.
- Prošlo je **87 ciljanih upstream provjera pravila**. Dodatno je nakon
  popravka provjereno 18 Advantage / trigger-window scenarija.
- HTTP provjera odigrava cijelu Luke/Vader partiju na svakoj od tri težine,
  uključujući odbijanje zastarjelog prompta i provjeru da AI zapis ne objavljuje
  nazive tajno odabranih karata.
- Playwright provjera odigrava cijelu partiju kroz stvarne gumbe i karte
  sučelja, bez JavaScript grešaka; provjereni su desktop i mobilni prikaz.
- TypeScript i Vite produkcijski build prolaze.

Strojni izvještaji: [simulacije](validation-smoke.json),
[HTTP](validation-http.json), [preglednik](validation-browser.json),
[pokrivenost špilova](../data/coverage.json).

`validation-smoke.json` bilježi SHA-256 točnih ulaznih datoteka, trajanja,
tipove promptova i završetak svake partije. Ova provjera nije iscrpan dokaz
svih mogućih redoslijeda efekata i kombinacija karata.

Za ponavljanje osnovne provjere:

```sh
npm run engine:setup
npm test
npm run test:smoke
npm run cards:check
npm run build
```

Uz pokrenut `npm start`, dodatno:

```sh
node scripts/http-smoke.cjs
npx playwright install chromium
node scripts/browser-smoke.mjs
```

Slike: [zapovjedništvo](screenshots/command.png),
[bojište](screenshots/battle.png), [mobilni prikaz](screenshots/battle-mobile.png).
