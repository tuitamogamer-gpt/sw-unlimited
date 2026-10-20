# Online 1v1 — šta trebaš postaviti

Trebaš svoj postojeći Supabase projekt i pristup Vercel projektu `sw-unlimited`.
Google OAuth i prijava igrača nisu potrebni: prijatelji ulaze preko privatnog linka.

## 1. Pripremi bazu u Supabaseu

1. Otvori [Supabase dashboard](https://supabase.com/dashboard) i izaberi svoj projekt.
2. Otvori **SQL Editor → New query**.
3. Otvori datoteku [supabase/rooms.sql](../supabase/rooms.sql) u ovom repozitoriju
   i kopiraj njen cijeli sadržaj u editor.
4. Klikni **Run**. Očekivano je `Success. No rows returned`.

SQL dodaje privatnu tabelu `swu_rooms` i funkciju `swu_compare_room` koja sprečava
istovremene poteze da prepišu jedan drugi. Ne briše postojeće tabele.
Nemoj isključivati RLS niti davati browserima pristup ovoj tabeli.

## 2. Pronađi URL i serverski ključ

U Supabase postavkama projekta pronađi:

- **Project URL** u **Settings → Data API** (u nekim verzijama pod **API**),
  oblika `https://…supabase.co`.
- **service_role** ključ u **Settings → API Keys → Legacy anon, service_role API keys**.
  Izaberi `service_role`, ne `anon` ili publishable ključ.

Serverski ključ kopiraj direktno u Vercel u sljedećem koraku. Nemoj ga slati u
chat, stavljati u GitHub, kod ili screenshot. Ne koristi prefiks `VITE_`.

## 3. Dodaj dvije Vercel varijable

Otvori [postavke Vercel projekta](https://vercel.com/tuitamogamer-7851s-projects/sw-unlimited/settings/environment-variables)
pa **Settings → Environment Variables**.

| Name | Value | Environment |
| --- | --- | --- |
| `SUPABASE_URL` | Project URL iz prethodnog koraka | Production |
| `SUPABASE_SERVICE_ROLE_KEY` | `service_role` ključ | Production |

Označi serverski ključ kao **Sensitive** ako Vercel ponudi tu opciju. Sačuvaj obje
varijable. Postojeći `SWU_SESSION_SECRET` ostavi kako jeste.

Za provjeru na testnoj objavi možeš dodati iste nazive i za **Preview**;
poseban Supabase projekt za testiranje izbjegava miješanje testnih i pravih soba.
Za korištenje glavnog sajta dovoljno je postaviti **Production**.

## 4. Javi da je spremno

Pošalji samo **„SQL i Vercel varijable su postavljeni“**. Ne trebaš slati vrijednosti.
Tada mogu provjeriti konfiguraciju, objaviti pripremljeni kod i potvrditi rad
dvije odvojene sesije. Promjena varijabli zahtijeva novu objavu; već pokrenuta
Vercel objava ih neće automatski preuzeti.

Nakon aktivacije na [igri](https://sw-unlimited-mu.vercel.app):

1. **Igraj s prijateljem · Online 1 na 1 → Napravi privatnu sobu**.
2. Pošalji pozivni link prijatelju.
3. Prijatelj izabere svoj špil i klikne **Pridruži se sobi**.

Za samostalnu provjeru koristi dva različita profila preglednika ili običan i
privatan prozor. Dvije kartice istog profila dijele pristup istom igračkom mjestu.
Partija ostaje dostupna u originalnom pregledniku do šest sati; zatvaranje
kartice ne predaje partiju.

## Ako nešto zapne

- SQL greška: pošalji tekst greške bez ključeva.
- `Online igra još nije spremna`: provjeriti nazive varijabli, izabrano okruženje
  i da li je pokrenuta nova objava s 1v1 kodom.
- Soba se ne kreira iako je online opcija dostupna: provjeriti da SQL i varijable
  pripadaju istom Supabase projektu te da je projekt aktivan.
- Održavanje kasnije: u Supabaseu se može zakazati brisanje isteklih soba naredbom
  `delete from public.swu_rooms where expires_at < now();`. To nije potrebno za
  prvu probu; aplikacija već odbija pristup isteklim sobama.

Trenutno postavljanje nisam mogao izvršiti kroz povezani pristup: Vercelov API
za integracije vraća **403**, a Supabase pristup nije povezan s ovim okruženjem.
