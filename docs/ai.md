# AI protivnik

`server/bot.cjs` izvozi `chooseAction(view, { difficulty, memory })`. Rezultat sadrži
`action`, kratko obrazloženje `reason`, numerički rezultat, do tri alternative i
memoriju koja se može ponovno predati sljedećem pozivu. `memory` se mijenja na mjestu.
`action: null` znači da bot trenutačno nema aktivan izbor.

Bot radi isključivo nad prikazom koji vraća adapter pravila. Ne uvozi Forceteki,
ne pristupa objektu partije i ne mijenja stanje pravila. Naredbu bira iz
`legalActions`; jedini sastavljeni dio naredbe jest raspodjela štete, liječenja ili
tokena koju adapter ponovno validira.

## Razrađen sustav odluka

- **Mulligan i resursi:** traži jedinicu do cijene 2 i nastavak krivulje; pri
  resursiranju čuva rane poteze, upotrebljive karte i vrijednost ruke te smanjuje
  vrijednost preskupih ili redundantnih karata. Kasnije može preskočiti resurs.
- **Borba:** prioritet imaju vidljivi završni napad i uklanjanje jedinice koja
  odmah prijeti bazi. Procjenjuje razmjene, preživljavanje, spremnost protivnika,
  Sentinel unutar arene, Saboteur, štitove, Raid i Overwhelm.
- **Razvoj:** uspoređuje napad, igranje karte, deploy vođe i ostale akcije.
  Vrednuje jedinice, uklanjanje, dodatne karte, liječenje, Ambush i zaštitu baze.
- **Inicijativa:** uzima inicijativu kada preostale akcije nemaju dovoljnu vrijednost.
- **Složeni izbori:** podržava višestruke mete, potvrde, redoslijed karata,
  izbor prikazanih karata, izbornike po karti, okidače, brojeve, padajuće izbornike,
  liječenje te izravnu i indirektnu štetu. Poštuje broj ciljeva, ukupnu raspodjelu
  i zabranu viška indirektne štete na jedinici. Pamti prethodni izbor sposobnosti
  kroz sljedeće upite. Za generički izbor „Choose a unit” koristi javni tekst
  izvora kako bi razlikovao uklanjanje od pojačanja, uključujući Advantage.
  Već odabrane karte ne uključuje i isključuje u petlji. Pamti i ponavljanje
  akcije na nepromijenjenoj javnoj ploči, čak i ako engine stvori novi ID upita;
  time izbjegava ponavljanje sposobnosti bez korisnog učinka.

## Težine

| Vrijednost | Prikaz | Ponašanje |
| --- | --- | --- |
| `easy` | Kadet | Veća razlika pri izboru sličnih poteza; slabije obrambene procjene. |
| `normal` | Vitez | Dosljedna taktička procjena ploče i krivulje. |
| `hard` | Majstor | Planira korištenje ostatka resursa kao problem ruksaka i procjenjuje vidljivu protivničku odmazdu. |

Težine imaju ista pravila i iste informacije. Ovo je heuristički bot, nije
model treniran na partijama niti potpuno pretraživanje budućeg stabla igre.
Procjena budućeg napada približna je: konačnu zakonitost meta, tekst karata,
okidače i sve iznimke uvijek određuje engine. Ne obećava optimalan potez za
svaku kombinaciju svih objavljenih karata. Semantiku neuobičajenih izbornih
efekata procjenjuje prema ponuđenom tekstu i legalnim opcijama.

## Granica informacija

`observe()` stvara dodatni eksplicitni popis dopuštenih polja. Bot vidi vlastitu
ruku, vlastite resurse, javne arene, vođe, baze, odbačene karte, broj protivničkih
karata/resursa i karte koje trenutačni efekt legalno otkriva. Nikada ne čita
protivničku ruku ili identitet resursa ni redoslijed i sadržaj skrivenog špila
bilo kojeg igrača. Nema pristup seedu generatora slučajnih brojeva. Memorija
sadrži samo vlastite prethodne odluke i javno dopuštene ID-jeve.

`tests/bot.test.cjs` provjerava završni napad, zaštitu baze, Sentinel/Saboteur,
mulligan, resurse, složene upite i legalnost raspodjele. Test privatnosti postavlja
gettere koji bacaju iznimku na svako čitanje zabranjenih polja; drugi test mijenja
skrivene karte i potvrđuje da se odluka ne mijenja. Dodatne testove cijelih
partija pokreće `npm run test:smoke`.
