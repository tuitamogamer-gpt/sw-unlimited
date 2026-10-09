import { useSyncExternalStore } from 'react';

export type Language = 'en' | 'sr';
export type TranslationVariables = Record<string, string | number>;
const STORAGE_KEY = 'swu-language';
const subscribers = new Set<() => void>();
function readLanguage(): Language {
  try { return localStorage.getItem(STORAGE_KEY) === 'sr' ? 'sr' : 'en'; } catch { return 'en'; }
}
let language: Language = readLanguage();
function updateDocumentLanguage() {
  if (typeof document !== 'undefined') document.documentElement.lang = language === 'sr' ? 'sr-Latn' : 'en';
}
updateDocumentLanguage();
export function setLanguage(next: Language): void {
  if (next !== 'en' && next !== 'sr') return;
  language = next;
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* A private tab can still switch language. */ }
  updateDocumentLanguage();
  subscribers.forEach(listener => listener());
}
if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if (event.key !== STORAGE_KEY) return;
  language = readLanguage();
  updateDocumentLanguage();
  subscribers.forEach(listener => listener());
});
const subscribe = (listener: () => void) => { subscribers.add(listener); return () => { subscribers.delete(listener); }; };

// Each row is [English, Serbian Latin, optional legacy interface wording].
// Unknown strings (including official card titles and rules text) remain intact.
const copy: Array<[string, string, ...string[]]> = [
  ['Start a new game?', 'Započni novu partiju?'],
  ['Your current saved game will be replaced. Keep playing to return to it.', 'Trenutna sačuvana partija biće zamenjena. Izaberi „Nastavi da igraš” da joj se vratiš.'],
  ['Start new game', 'Započni novu partiju'],
  ['Reconnected. Your saved game is ready.', 'Veza je obnovljena. Sačuvana partija je spremna.'],
  ['Reconnect', 'Poveži se ponovo'], ['Swipe for more', 'Prevuci za još'], ['Latest move', 'Poslednji potez'],
  ['Your units', 'Tvoje jedinice'], ['Opponent units', 'Protivničke jedinice'], ['Health change', 'Promena života'],

  ['The request timed out. The server may still be processing it.', 'Zahtev je prekoračio vreme čekanja. Server ga možda još obrađuje.'],
  ['The request was cancelled. An action already sent may still finish on the server.', 'Zahtev je otkazan. Već poslata akcija možda će ipak biti završena na serveru.'],
  ['The connection was interrupted. Check your connection and reconnect.', 'Veza je prekinuta. Proveri vezu i poveži se ponovo.'],
  ['The server returned an incomplete response. Your saved game has been kept.', 'Server je vratio nepotpun odgovor. Sačuvana partija je zadržana.'],
  ['This game is being updated in another request or tab. Wait a moment, then reconnect.', 'Partija se ažurira drugim zahtevom ili u drugoj kartici. Sačekaj trenutak, pa se poveži ponovo.'],
  ['A newer saved turn was found. The board was refreshed; review it before choosing another action.', 'Pronađen je noviji sačuvani potez. Bojište je osveženo; proveri ga pre sledeće akcije.'],
  ['The response was interrupted. A saved board was recovered; your last action may not be included. Review the board before continuing.', 'Odgovor je prekinut. Sačuvano bojište je vraćeno; poslednja akcija možda nije uključena. Proveri bojište pre nastavka.'],
  ['The action could not be confirmed. Reconnect before choosing another action; it will not be sent again automatically.', 'Nije moguće potvrditi akciju. Poveži se ponovo pre sledeće akcije; prethodna neće biti automatski ponovljena.'],
  ['The saved board was refreshed. Review it before choosing another action.', 'Sačuvano bojište je osveženo. Proveri ga pre sledeće akcije.'],
  ['Browser storage is unavailable. Your game is kept in this tab; keep it open to continue.', 'Skladište pregledača nije dostupno. Partija se čuva u ovoj kartici; ostavi je otvorenu da bi nastavio igru.'],
  ['The server is unavailable. Try reconnecting.', 'Server nije dostupan. Pokušaj ponovo da se povežeš.'],

  ['NO PLAYABLE CARDS', 'NEMA DOSTUPNIH KARATA ZA IGRANJE'],
  ['NEED +{count}', 'NEDOSTAJE {count}'],
  ['No cards can be played now. Use a ready unit or ability, or pass.', 'Sada ne možeš odigrati kartu. Upotrebi spremnu jedinicu ili sposobnost, ili preskoči akciju.'],
  ['Choose 2 cards as resources. Keep low-cost units in hand to play this round.', 'Izaberi 2 karte za resurse. Zadrži jeftine jedinice u ruci da ih igraš ove runde.'],
  ['This card has no legal play right now. Open its details to check its requirements.', 'Ovu kartu trenutno ne možeš odigrati. Otvori detalje i proveri njene uslove.'],
  ['This unit is exhausted. It readies during regroup.', 'Ova jedinica je iscrpljena. Biće spremna tokom regrupisavanja.'],
  ['LATEST DECISION', 'POSLEDNJA ODLUKA'],
  ['Evaluating the battlefield…', 'Procenjujem bojište…'],
  ['The AI weighs base damage, tempo, threats, and favorable trades.', 'AI procenjuje štetu na bazama, tempo, pretnje i povoljne razmene.'],
  ['Awaiting your first orders.', 'Čekamo tvoje prve naredbe.'],
  ['Hide battle log', 'Sakrij dnevnik bitke'], ['Show battle log', 'Prikaži dnevnik bitke'],
  ['How to play', 'Kako se igra'], ['Start a new game', 'Započni novu partiju'],
  ['Opponent hand: {count} cards', 'Protivnikova ruka: {count} karata'],
  ['IN HAND', 'U RUCI'], ['Battle arena', 'Arena za borbu'],
  ['View your resources', 'Pregledaj svoje resurse'], ['SELECT RESOURCES', 'IZABERI RESURSE'],
  ['TAP A PLAY BUTTON', 'DODIRNI DUGME ODIGRAJ'], ['TAP TO INSPECT', 'DODIRNI ZA DETALJE'],
  ['Game complete', 'Partija je završena'], ['DEPLOY', 'RASPOREDI'], ['ABILITY', 'SPOSOBNOST'],
  ['Inspect {name}', 'Pregledaj {name}'], ['inspect card', 'pregledaj kartu'],
  ['{name}, {hp} of {max} health', '{name}, život {hp} od {max}'],
  ['TARGET BASE', 'NAPADNI BAZU'], ['Cards in deck', 'Karte u špilu'],
  ['Opponent discard pile', 'Protivnikova odbačena hrpa'], ['READY', 'SPREMNO'],
  ['OPPONENT SECTOR', 'PROTIVNIČKI SEKTOR'], ['RESOURCE SELECTED', 'RESURS IZABRAN'],
  ['RESOURCE', 'RESURS'], ['PLAY', 'ODIGRAJ'], ['ATTACK', 'NAPADNI'],
  ['SELECTED', 'IZABRANO'], ['SELECT TARGET', 'IZABERI CILJ'],
  ['NEED {count}', 'POTREBNO {count}'], ['UNAVAILABLE', 'NEDOSTUPNO'], ['Resource cost', 'Cena u resursima'],
  ['Resolving your action…', 'Razrešavanje tvoje akcije…'],
  ['Resource step · optional', 'Izbor resursa · neobavezno'],
  ['Choose your starting resources', 'Izaberi početne resurse'],
  ['Your action', 'Tvoja akcija'], ['Keep your hand or redraw?', 'Zadrži ruku ili izvuci novu?'],
  ['Who takes the initiative?', 'Ko preuzima inicijativu?'],
  ['Choose 1 card as a resource, or skip. Then the action phase begins.', 'Izaberi 1 kartu za resurs ili preskoči. Zatim počinje akcijska faza.'],
  ['Choose 2 cards to become resources. You will play units after this step.', 'Izaberi 2 karte za resurse. Posle ovog koraka moći ćeš da igraš jedinice.'],
  ['Play a card from your hand, attack with a ready unit, or use an ability.', 'Odigraj kartu iz ruke, napadni spremnom jedinicom ili upotrebi sposobnost.'],
  ['You may replace your entire starting hand once.', 'Možeš jednom zameniti celu početnu ruku.'],
  ['Choose a highlighted target. The other arena may also have targets.', 'Izaberi označeni cilj. Ciljevi mogu biti i u drugoj areni.'],
  ['Select your cards, then confirm the choice.', 'Izaberi karte, pa potvrdi izbor.'],
  ['Choose a number', 'Izaberi broj'], ['Confirm choice', 'Potvrdi izbor'],
  ['Distribute healing', 'Raspodeli lečenje'], ['Distribute tokens', 'Raspodeli žetone'], ['Distribute damage', 'Raspodeli štetu'],
  ['Decrease {name}', 'Smanji {name}'], ['Increase {name}', 'Povećaj {name}'], ['Up to {count} targets.', 'Najviše {count} ciljeva.'],
  ['End your actions this phase', 'Završi svoje akcije u ovoj fazi'], ['Commands', 'Naredbe'],
  ['MISSION COMPLETE', 'MISIJA ZAVRŠENA'], ['RESOURCE SELECTION', 'IZBOR RESURSA'], ['OPPONENT TURN', 'PROTIVNIČKI POTEZ'],
  ['Dismiss', 'Zatvori'], ['Choose options', 'Izaberi opcije'], ['All actions', 'Sve akcije'], ['All targets', 'Svi ciljevi'],
  ['Available choices', 'Dostupni izbori'], ['Back to battlefield', 'Nazad na bojište'],
  ['Claim initiative?', 'Preuzmi inicijativu?'],
  ['You will take no more actions this phase. Your opponent may keep playing. You act first next round.', 'Završavaš svoje akcije za ovu fazu. Protivnik može nastaviti da igra. Ti igraš prvi u sledećoj rundi.'],
  ['Keep playing', 'Nastavi da igraš'], ['The Force', 'Sila'],
  ['Choose resources now. Cards can be played during the action phase.', 'Sada izaberi resurse. Karte možeš igrati tokom akcijske faze.'],
  ['Cards can be played during the action phase.', 'Karte možeš igrati tokom akcijske faze.'],
  ['Wait for your next action before playing a card.', 'Sačekaj svoju sledeću akciju pre igranja karte.'],
  ['You cannot pay this card’s cost with the available resources and payment options.', 'Ne možeš platiti cenu ove karte dostupnim resursima i načinima plaćanja.'],
  ['There is no legal unit to attach this card to.', 'Ne postoji dozvoljena jedinica kojoj možeš priključiti ovu kartu.'],
  ['This card has no legal effect right now.', 'Ova karta trenutno nema dozvoljeni efekat.'],
  ['An active card effect prevents this card from being played.', 'Aktivan efekat sprečava igranje ove karte.'],
  ['Resolve the current required action first.', 'Prvo razreši trenutnu obaveznu akciju.'],
  ['This play option is not available right now.', 'Ovaj način igranja trenutno nije dostupan.'],
  ['This card cannot be played from your hand right now.', 'Ovu kartu trenutno ne možeš odigrati iz ruke.'],

  ['Cadet', 'Kadet', 'Kadet'],
  ['Commander', 'Komandant', 'Zapovjednik'],
  ['Grand Admiral', 'Veliki admiral', 'Veliki admiral'],
  ['First steps and relaxed play.', 'Prvi koraci i opuštena partija.', 'Prvi koraci i opuštena partija.'],
  ['Evaluates tempo, threats, and card value.', 'Procenjuje tempo, pretnje i vrednost karata.', 'Procjenjuje tempo, prijetnje i vrijednost karata.'],
  ['Combat priorities, synergies, and resource planning.', 'Prioriteti borbe, sinergije i planiranje resursa.', 'Prioriteti borbe, sinergije i planiranje resursa.'],
  ['Official rules and errata', 'Zvanična pravila i ispravke', 'Službena pravila i errata'],
  ['Fantasy Flight Games · reference rules', 'Fantasy Flight Games · referentna pravila', 'Fantasy Flight Games · referentna pravila'],
  ['Card database and public API', 'Baza karata i javni API', 'Baza karata i javni API'],
  ['Open-source rules engine and card scripts', 'Otvoreni sistem pravila i skripte karata', 'Otvoreni sustav pravila i skripte karata'],
  ['Card discussions and game situations', 'Rasprave o kartama i situacijama u igri', 'Rasprave o kartama i situacijama u igri'],
  ['Rules questions and community discussions', 'Pitanja o pravilima i rasprave zajednice', 'Pitanja o pravilima i rasprave zajednice'],
  ['Command', 'Komanda', 'Zapovjedništvo'],
  ['Back to command', 'Nazad u komandu', 'Povratak u zapovjedništvo'],
  ['Main navigation', 'Glavna navigacija', 'Glavna navigacija'],
  ['Game rules', 'Pravila igre', 'Pravila igre'],
  ['Rules', 'Pravila'],
  ['Sources', 'Izvori', 'Izvori'],
  ['SYSTEM ONLINE', 'SISTEM AKTIVAN', 'SUSTAV AKTIVAN'],
  ['Settings', 'Podešavanja', 'Postavke'],
  ['Close', 'Zatvori', 'Zatvori'],
  ['Dismiss notification', 'Zatvori obaveštenje', 'Zatvori obavijest'],
  ['TACTICAL SIMULATOR · 1V1', 'TAKTIČKI SIMULATOR · 1 NA 1', 'TAKTIČKI SIMULATOR · 1 NA 1'],
  ['THE GALAXY AWAITS', 'GALAKSIJA ČEKA', 'GALAKSIJA ČEKA'],
  ['YOUR', 'TVOG', 'TVOG'],
  ['COMMAND.', 'KOMANDANTA.', 'ZAPOVJEDNIKA.'],
  ['Choose your side. Assemble your fleet.', 'Izaberi stranu. Okupi flotu.', 'Izaberi svoju stranu. Okupi flotu.'],
  ['Face an AI opponent in Star Wars: Unlimited.', 'Odmeri snage sa AI protivnikom u igri Star Wars: Unlimited.', 'Odmjeri snage s AI protivnikom u igri Star Wars: Unlimited.'],
  ['Play against AI', 'Igra protiv AI-ja', 'Igra protiv AI-ja'],
  ['Automated rules', 'Automatizovana pravila', 'Automatizirana pravila'],
  ['Starter decks', 'Početni špilovi', 'Početni špilovi'],
  ['Resume last game', 'Nastavi poslednju partiju', 'Nastavi posljednju partiju'],
  ['Resume game', 'Nastavi partiju'],
  ['CONFLICT IS INEVITABLE', 'SUKOB JE NEIZBEŽAN', 'SUKOB JE NEIZBJEŽAN'],
  ['THE CHOICE IS YOURS.', 'ODLUKA JE TVOJA.', 'ODLUKA JE TVOJA.'],
  ['Game setup', 'Priprema partije', 'Postavljanje partije'],
  ['01 / MISSION SETUP', '01 / PRIPREMA MISIJE', '01 / PRIPREMA MISIJE'],
  ['YOUR DECK', 'TVOJ ŠPIL', 'TVOJ ŠPIL'],
  ['Choose a commander', 'Izaberi komandanta', 'Odaberi zapovjednika'],
  ['Loading archive…', 'Učitavanje arhive…', 'Učitavanje arhive…'],
  ['AI OPPONENT', 'AI PROTIVNIK', 'AI PROTIVNIK'],
  ['Choose an opponent', 'Izaberi protivnika', 'Odaberi protivnika'],
  ['OPPONENT LEVEL', 'NIVO PROTIVNIKA', 'RAZINA PROTIVNIKA'],
  ['Preparing battlefield…', 'Priprema bojišta…', 'Priprema bojišta…'],
  ['Start battle', 'Započni bitku', 'Započni bitku'],
  ['02 / DECK ARCHIVE', '02 / ARHIVA ŠPILOVA', '02 / ARHIVA ŠPILOVA'],
  ['CHOOSE YOUR SIDE', 'IZABERI STRANU', 'IZABERI SVOJU STRANU'],
  ['Choosing a deck for:', 'Biraš špil za:', 'Biraš špil za:'],
  ['yourself', 'sebe', 'sebe'],
  ['AI opponent', 'AI protivnika', 'AI protivnika'],
  ['Filter set', 'Filtriraj set', 'Filtriraj set'],
  ['All decks', 'Svi špilovi', 'Svi špilovi'],
  ['Search decks', 'Pretraži špilove', 'Pretraži špilove'],
  ['Find a commander…', 'Pronađi komandanta…', 'Pronađi zapovjednika…'],
  ['Accessing galactic archive…', 'Pristup galaktičkoj arhivi…', 'Pristup galaktičkoj arhivi…'],
  ['Archive currently unavailable', 'Arhiva trenutno nije dostupna', 'Arhiva trenutačno nije dostupna'],
  ['Check your connection and try again.', 'Proveri vezu i pokušaj ponovo.', 'Provjeri vezu s poslužiteljem i pokušaj ponovo.'],
  ['Try again', 'Pokušaj ponovo', 'Pokušaj ponovo'],
  ['No decks found', 'Nema pronađenih špilova', 'Nema pronađenih špilova'],
  ['Clear filters', 'Očisti filtere', 'Očisti filtere'],
  ['TACTICAL ADVANTAGE', 'TAKTIČKA PREDNOST', 'TAKTIČKA PREDNOST'],
  ['One action. Endless possibilities.', 'Jedna akcija. Bezbroj mogućnosti.', 'Jedna akcija. Bezbroj mogućnosti.'],
  ['Alternate actions, develop resources, and fight across two arenas. Destroy the enemy base before yours falls.', 'Igrajte naizmenično, razvijajte resurse i borite se u dve arene. Uništi protivničku bazu pre nego što padne tvoja.', 'Igrajte naizmjence, razvijajte resurse i napadajte u dvije arene. Uništi protivničku bazu prije nego što padne tvoja.'],
  ['Claim initiative', 'Preuzmi inicijativu', 'Preuzmi inicijativu', 'Claim Initiative', 'Take initiative'],
  ['The first action next round can change everything.', 'Prva akcija sledeće runde može promeniti sve.', 'Prvi potez sljedeće runde može promijeniti sve.'],
  ['Control both arenas', 'Vladaj obema arenama', 'Vladaj objema arenama'],
  ['Coordinate ground forces and your space fleet.', 'Poveži kopnene snage i svemirsku flotu.', 'Poveži kopnene snage i svemirsku flotu.'],
  ['Deploy your leader', 'Rasporedi vođu', 'Rasporedi vođu'],
  ['Send your commander into battle at the right moment.', 'Pošalji komandanta u borbu u pravom trenutku.', 'U pravom trenutku pošalji zapovjednika u borbu.'],
  ['Unofficial community project. Star Wars and related content © Lucasfilm / Fantasy Flight Games.', 'Nezvanični projekat zajednice. Star Wars i pripadajući sadržaj © Lucasfilm / Fantasy Flight Games.', 'Neslužbeni projekt zajednice. Star Wars i pripadajući sadržaj © Lucasfilm / Fantasy Flight Games.'],
  ['Data and sources', 'Podaci i izvori', 'Podaci i izvori'],
  ["Commander's handbook", 'Priručnik komandanta', 'Priručnik zapovjednika'],
  ['Sources and data', 'Izvori i podaci', 'Izvori i podaci'],
  ['System settings', 'Podešavanja sistema', 'Postavke sustava'],
  ['Official rules take precedence over community interpretations. Community sources explain specific situations.', 'Zvanična pravila imaju prednost nad tumačenjima zajednice. Izvori zajednice pojašnjavaju specifične situacije.', 'Službena pravila imaju prednost pred tumačenjima zajednice. Izvori zajednice služe za pojašnjenja specifičnih situacija.'],
  ['This project is not affiliated with Lucasfilm, FFG, or Karabast. The catalog shows script availability; deck-specific limitations are listed with each deck.', 'Projekat nije zvanično povezan sa Lucasfilmom, FFG-om ili Karabastom. Katalog prikazuje dostupnost skripti; posebna ograničenja navedena su uz špil.', 'Projekt nije službeno povezan s Lucasfilmom, FFG-om ili Karabastom. Katalog prikazuje dostupnost skripti; posebna ograničenja navedena su uz špil.'],
  ['AI difficulty', 'Težina AI protivnika', 'Razina AI protivnika'],
  ['Changes apply to your next game.', 'Promena važi za sledeću partiju.', 'Promjena vrijedi za sljedeću partiju.'],
  ['Compact cards', 'Kompaktne karte', 'Kompaktne karte'],
  ['More room for large arenas.', 'Više prostora za velike arene.', 'Više prostora za velike arene.'],
  ['Game log', 'Dnevnik partije', 'Dnevnik partije'],
  ['Show actions beside the battlefield.', 'Prikaži poteze uz bojište.', 'Prikaži poteze uz bojište.'],
  ['Your game is saved securely in this browser for six hours after it starts. Resume after refreshing. Use one browser tab per game.', 'Partija se šifrovano čuva u ovom pregledaču do šest sati od početka. Možeš nastaviti nakon osvežavanja. Koristi jednu karticu pregledača po partiji.', 'Partija se šifrirano pamti u ovom pregledniku do šest sati od početka. Možeš je nastaviti nakon osvježavanja stranice. Koristi jednu karticu preglednika po partiji.'],
  ['Language', 'Jezik'], ['English', 'English'], ['Serbian', 'Srpski'], ['Serbian (Latin)', 'Srpski (latinica)'],
  ['Card details', 'Detalji karte', 'Detalji karte'],
  ['Card', 'Karta', 'Karta'],
  ['Show active side', 'Pokaži aktivnu stranu', 'Pokaži aktivnu stranu'],
  ['Flip card', 'Okreni kartu', 'Okreni kartu'],
  ['GALACTIC ARCHIVE', 'GALAKTIČKA ARHIVA', 'GALAKTIČKA ARHIVA'],
  ['COST', 'CENA', 'CIJENA'], ['POWER', 'SNAGA', 'SNAGA'], ['HEALTH', 'ŽIVOT', 'ŽIVOT'],
  ['Ability text is shown on the card image.', 'Tekst sposobnosti prikazan je na slici karte.', 'Tekst sposobnosti prikazan je na slici karte.'],
  ['Exhausted card', 'Iscrpljena karta', 'Iscrpljena karta'],
  ['Upgrades', 'Nadogradnje', 'Nadogradnje'],
  ['Captured units', 'Zarobljene jedinice', 'Zarobljene jedinice'],
  ['This card script is not available in the included engine.', 'Skripta ove karte nije dostupna u ugrađenom sistemu.', 'Skripta ove karte nije dostupna u ugrađenom sustavu.'],
  ['Official preconstructed deck.', 'Zvanični unapred složen špil.', 'Službeni unaprijed složen špil.'],
  ['This deck contains cards without scripts and cannot currently start a game.', 'Špil sadrži karte bez dostupnih skripti i trenutno nije moguće započeti partiju sa njim.', 'Špil sadrži karte bez dostupnih skripti i trenutačno nije moguće započeti partiju s njim.'],
  ['This deck list is available in the imported server data.', 'Sastav špila dostupan je u uvezenim podacima na serveru.', 'Sastav ovog špila dostupan je u uvezenim podacima na poslužitelju.'],
  ['Choose deck', 'Izaberi špil', 'Odaberi špil'],
  ['Draw', 'Nerešeno', 'Neriješen ishod'],
  ['Mission accomplished', 'Misija uspešno završena', 'Misija uspješno završena'],
  ['Battle complete', 'Bitka je završena', 'Bitka je završena'],
  ['ROUND', 'RUNDA', 'RUNDA'], ['Round', 'Runda'],
  ['BALANCE IN THE GALAXY.', 'RAVNOTEŽA U GALAKSIJI.', 'RAVNOTEŽA U GALAKSIJI.'],
  ['VICTORY IS YOURS.', 'POBEDA JE TVOJA.', 'POBJEDA JE TVOJA.'],
  ['THE GALAXY REMEMBERS THE BRAVE.', 'GALAKSIJA PAMTI HRABRE.', 'GALAKSIJA PAMTI HRABRE.'],
  ['Both bases fell at the same time. The game is a draw.', 'Obe baze pale su istovremeno. Partija je završena nerešeno.', 'Obje baze pale su istodobno. Partija je završila neriješeno.'],
  ['The enemy base has fallen. Mission accomplished, commander.', 'Protivnička baza je pala. Misija je završena, komandante.', 'Protivnička baza je pala. Odličan posao, zapovjedniče.'],
  ['Your opponent won this battle. A new plan brings another chance.', 'Protivnik je dobio ovu bitku. Novi plan donosi novu priliku.', 'Ovaj put protivnik je bio uspješniji. Novi plan, nova prilika.'],
  ['New game', 'Nova partija', 'Nova partija'],
  ['Review final board', 'Pregledaj završno stanje', 'Pregledaj završno stanje'],
  ['Scripts missing', 'Skripte nedostaju', 'Skripte nedostaju'],
  ['View deck', 'Pregled špila', 'Pregled špila'],
  ['Hide log', 'Sakrij dnevnik', 'Sakrij dnevnik'],
  ['Show log', 'Prikaži dnevnik', 'Prikaži dnevnik'],
  ['New game with these decks', 'Nova partija sa istim špilovima', 'Nova partija s istim špilovima'],
  ['CARDS IN HAND', 'KARATA U RUCI', 'KARATA U RUCI'],
  ['GROUND ARENA', 'KOPNENA ARENA', 'KOPNENA ARENA'],
  ['SPACE ARENA', 'SVEMIRSKA ARENA', 'SVEMIRSKA ARENA'],
  ['Ground', 'Kopno'], ['Space', 'Svemir'], ['GROUND', 'KOPNO'], ['SPACE', 'SVEMIR'],
  ['READY RESOURCES', 'SPREMNI RESURSI', 'RASPOLOŽIVI RESURSI'],
  ['Your resources', 'Tvoji resursi', 'Tvoji resursi'],
  ['View resources', 'Pregled resursa', 'Pregled resursa'],
  ['Continue AI turn', 'Nastavi AI potez', 'Nastavi AI potez'],
  ['Your hand', 'Tvoja ruka', 'Tvoja ruka'],
  ['YOUR HAND', 'TVOJA RUKA', 'TVOJA RUKA'],
  ['Use the magnifier to inspect a card', 'Povećalo otvara detalje karte', 'Ikona povećala otvara detalje karte'],
  ['Your hand is empty.', 'Nemaš karata u ruci.', 'Nemaš karata u ruci.'],
  ['TACTICAL CENTER', 'TAKTIČKI CENTAR', 'TAKTIČKI CENTAR'],
  ['LAST DECISION', 'POSLEDNJA ODLUKA', 'POSLJEDNJA PROCJENA'],
  ['Analyzing the battlefield…', 'Analiziram bojište…', 'Analiziram stanje bojišta…'],
  ['The AI evaluates tempo, base health, threats, and unit trades.', 'AI procenjuje tempo, stanje baza, pretnje i razmene jedinica.', 'AI procjenjuje tempo, stanje baza, prijetnje i vrijednost razmjene jedinica.'],
  ['Battle log', 'Dnevnik bitke', 'Dnevnik bitke'],
  ['Awaiting first orders.', 'Čekamo prve naredbe.', 'Čekamo prve naredbe.'],
  ['Game over', 'Partija je završena', 'Partija je završena'],
  ['Rules enforced by the game engine', 'Sistem igre proverava pravila', 'Pravila provjerava sustav igre'],
  ['Hidden card', 'Skrivena karta', 'Skrivena karta'],
  ['This pile is empty.', 'Ova hrpa je prazna.', 'Ova hrpa je prazna.'],
  ['YOUR COMMAND', 'TVOJA KOMANDA', 'TVOJA KOMANDA'],
  ['ACTIVE', 'NA POTEZU', 'NA POTEZU'],
  ['Leader', 'Vođa', 'Vođa'], ['Base', 'Baza', 'Baza'], ['BASE', 'BAZA', 'BAZA'],
  ['DECK', 'ŠPIL', 'ŠPIL'],
  ["Opponent's discard pile", 'Protivnikova odbačena hrpa', 'Protivnikova odbačena hrpa'],
  ['Your discard pile', 'Tvoja odbačena hrpa', 'Tvoja odbačena hrpa'],
  ['DISCARD', 'ODBAČENO', 'ODBAČENO'], ['Discard', 'Odbačeno'],
  ['RESOURCES', 'RESURSI', 'RESURSI'], ['Resources', 'Resursi'], ['Resource', 'Resurs'],
  ['Has initiative', 'Ima inicijativu', 'Ima inicijativu'],
  ['No initiative', 'Bez inicijative', 'Bez inicijative'],
  ['INITIATIVE', 'INICIJATIVA', 'INICIJATIVA'], ['Initiative', 'Inicijativa'],
  ['CLAIMED', 'PREUZETA', 'PREUZETA'], ['YOURS', 'TVOJA', 'TVOJA'],
  ['UNITS', 'JEDINICA', 'JEDINICA'],
  ['ENEMY SECTOR', 'PROTIVNIČKI SEKTOR', 'PROTIVNIČKI SEKTOR'],
  ['YOUR SECTOR', 'TVOJ SEKTOR', 'TVOJ SEKTOR'],
  ['EXHAUSTED', 'ISCRPLJENO', 'ISCRPLJENO'], ['Exhausted', 'Iscrpljeno'], ['Ready', 'Spremno'],
  ['Opponent plays', 'Protivnik igra'], ['Opponent deploys', 'Protivnik raspoređuje'],
  ['Joining the battlefield', 'Ulazi na bojište'], ['Resolving card', 'Razrešavanje karte'],
  ['Shield lost', 'Štit je izgubljen'], ['Defeated', 'Poraženo'], ['{card} defeated', 'Poražena karta: {card}'],
  ['captured', 'zarobljeno', 'zarobljeno'],
  ['Orders', 'Naredbe', 'Naredbe'],
  ['GAME OVER', 'KRAJ PARTIJE', 'KRAJ PARTIJE'],
  ['PROCESSING', 'OBRADA NAREDBE', 'OBRADA NAREDBE'],
  ['YOUR TURN', 'TVOJ POTEZ', 'TVOJ POTEZ'], ['Your turn', 'Tvoj potez'],
  ['GAME SYSTEM', 'SISTEM IGRE', 'SUSTAV IGRE'],
  ['The game has ended.', 'Partija je završena.', 'Partija je završena.'],
  ['Waiting for the next action…', 'Čekanje sledeće akcije…', 'Čekanje sljedeće akcije…'],
  ['Choose a highlighted card', 'Izaberi označenu kartu', 'Odaberi označenu kartu'],
  ['or multiple cards', 'ili više karata', 'ili više karata'],
  ['Available targets and choices', 'Dostupni ciljevi i izbori', 'Dostupni ciljevi i odabiri'],
  ['Choose a number (', 'Izaberi broj (', 'Odaberi broj ('],
  ['Confirm', 'Potvrdi', 'Potvrdi'],
  ['Confirm selection', 'Potvrdi izbor', 'Potvrdi odabir'],
  ['Choose an option', 'Izaberi opciju', 'Odaberi opciju'],
  ['Distribute', 'Raspodeli', 'Raspodijeli'],
  ['healing', 'lečenje', 'liječenje'], ['tokens', 'žetone', 'žetone'], ['damage', 'štetu', 'štetu'],
  ['You may distribute less than the total.', 'Možeš raspodeliti manje od ukupne količine.', 'Možeš raspodijeliti manje od ukupne količine.'],
  ['Distribute the full amount.', 'Raspodeli ukupnu količinu.', 'Raspodijeli ukupnu količinu.'],
  ['Confirm distribution', 'Potvrdi raspodelu', 'Potvrdi raspodjelu'],
  ['YOUR TOKENS', 'TVOJI ŽETONI', 'TVOJI ŽETONI'],
  ['ENEMY TOKENS', 'PROTIVNIČKI ŽETONI', 'PROTIVNIČKI ŽETONI'],
  ['Force', 'Sila', 'Sila'], ['Credit', 'Kredit', 'Kredit'],
  ['Your mission: destroy the enemy base.', 'Tvoja misija: uništi protivničku bazu.', 'Tvoja misija: uništi protivničku bazu.'],
  ['The engine handles costs, legal targets, triggers, and effects. You make the decisions.', 'Sistem obrađuje troškove, dozvoljene ciljeve, okidače i efekte. Ti donosiš odluke.', 'Sustav obrađuje troškove, dopuštene ciljeve, okidače i učinke. Ti donosiš odluke.'],
  ['01 / SETUP', '01 / PRIPREMA', '01 / PRIPREMA'],
  ['Choose resources', 'Izaberi resurse', 'Odaberi resurse'],
  ['Start with six cards. You may replace your entire opening hand once. Then choose two cards from your hand to become resources.', 'Počinješ sa šest karata. Možeš jednom zameniti celu početnu ruku. Zatim izaberi dve karte iz ruke koje postaju resursi.', 'Počinješ sa šest karata. Možeš jednom zamijeniti cijelu početnu ruku. Zatim odaberi dvije karte iz ruke koje postaju resursi.'],
  ['02 / ACTION PHASE', '02 / AKCIJSKA FAZA', '02 / AKCIJSKA FAZA'],
  ['One action at a time', 'Jedna akcija naizmenično', 'Jedna akcija naizmjence'],
  ['Play a card, attack with a ready unit, use an ability, or claim initiative. Highlighted cards have an available action or are legal targets.', 'Odigraj kartu, napadni spremnom jedinicom, upotrebi sposobnost ili preuzmi inicijativu. Označene karte imaju dostupnu akciju ili su dozvoljeni ciljevi.', 'Odigraj kartu, napadni spremnom jedinicom, upotrijebi sposobnost ili preuzmi inicijativu. Označene karte imaju dostupnu akciju ili su dopušteni ciljevi.'],
  ['03 / COMBAT', '03 / BORBA', '03 / BORBA'],
  ['Two separate arenas', 'Dve odvojene arene', 'Dvije zasebne arene'],
  ['Ground units fight in the ground arena; space units fight in space. Both can attack bases. Units deal damage simultaneously unless a card says otherwise.', 'Kopnene jedinice napadaju u kopnenoj areni, svemirske u svemirskoj. Obe mogu napasti bazu. Jedinice istovremeno nanose štetu, osim kada karta kaže drugačije.', 'Kopnene jedinice napadaju u kopnenoj areni, svemirske u svemirskoj. Obje mogu napasti bazu. Jedinice istodobno nanose štetu, osim kada učinak karte kaže drukčije.'],
  ['04 / NEXT ROUND', '04 / NOVA RUNDA', '04 / NOVA RUNDA'],
  ['Regroup', 'Regrupisavanje', 'Regrupiranje'],
  ['Draw two cards, optionally turn one card into a resource, and ready exhausted cards. The player with initiative begins the next round.', 'Izvuci dve karte, po želji pretvori jednu kartu iz ruke u resurs i pripremi iscrpljene karte. Igrač sa inicijativom započinje sledeću rundu.', 'Izvuci dvije karte, po želji pretvori jednu kartu iz ruke u resurs i pripremi iscrpljene karte. Igrač s inicijativom započinje sljedeću rundu.'],
  ['Battlefield controls', 'Komande na bojištu', 'Komande na bojištu'],
  ['Highlighted card — click to act or select a target.', 'Označena karta — klikni za akciju ili izbor cilja.', 'Označena karta — klikni za akciju ili odabir cilja.'],
  ['Magnifier — inspect the image, text, and state of a card.', 'Povećalo — otvori sliku, tekst i stanje karte.', 'Povećalo — otvori sliku, tekst i stanje karte.'],
  ['For multiple selections, choose your cards, then confirm.', 'Za višestruki izbor označi karte, pa potvrdi.', 'Kod višestrukog odabira označi karte, zatim potvrdi.'],
  ['Claiming initiative ends your actions for this phase.', 'Preuzimanje inicijative završava tvoje akcije za ovu fazu.', 'Preuzimanje inicijative završava tvoje akcije za ovu fazu.'],
  ['Card text can override the basic rules. Official card names and ability text remain in English for precision.', 'Tekst na kartama može promeniti osnovna pravila. Zvanični nazivi i tekst sposobnosti ostaju na engleskom radi preciznosti.', 'Tekst na kartama može promijeniti osnovna pravila. Izvorni nazivi i tekst sposobnosti ostaju na engleskom radi preciznosti.'],
  ['Official rules, errata, and sources', 'Zvanična pravila, ispravke i izvori', 'Službena pravila, errata i izvori'],
  ['Setup', 'Priprema', 'Priprema'], ['Action phase', 'Akcijska faza', 'Akcijska faza'],
  ['Pass', 'Preskoči akciju', 'Preskoči akciju'], ['Cancel', 'Odustani', 'Odustani'],
  ['Yes', 'Da', 'Da'], ['No', 'Ne', 'Ne'], ['Done', 'Potvrdi izbor'],
  ['Keep hand', 'Zadrži ruku', 'Zadrži ruku', 'Keep'],
  ['Mulligan', 'Nova početna ruka', 'Nova početna ruka'],
  ['Choose an action', 'Izaberi sledeću akciju', 'Odaberi svoju sljedeću akciju', 'Select an action'],
  ['Choose a card to resource', 'Izaberi kartu za resurs', 'Odaberi kartu za resurs'],
  ['Choose 2 cards to resource', 'Izaberi 2 karte za početne resurse', 'Odaberi 2 karte za početne resurse'],
  ['Pass priority', 'Prepusti akciju', 'Prepusti akciju'],
  ['Attack', 'Napadni', 'Napadni'], ['Play', 'Odigraj', 'Odigraj'], ['Deploy', 'Rasporedi'], ['Target', 'Izaberi cilj'], ['Select', 'Izaberi'],
  ['No target', 'Bez cilja', 'Bez cilja'],
  ['Pass for the phase', 'Preskoči do kraja faze', 'Preskoči do kraja faze'],
  ['Yourself', 'Ja', 'Ja'], ['Opponent', 'Protivnik', 'Protivnik'], ['You', 'Ti'],
  ['You won the flip. Choose the player to start with initiative:', 'Izaberi ko počinje sa inicijativom.', 'Odaberi tko počinje s inicijativom.'],
  ['Choose initiative player', 'Početna inicijativa', 'Početna inicijativa', 'choose initiative player'],
  ['Choose whether to mulligan or keep your hand', 'Zadrži početnu ruku ili izvuci novu.', 'Zadrži početnu ruku ili izvuci novu.'],
  ['Select 2 cards to resource', 'Izaberi 2 karte za početne resurse.', 'Odaberi 2 karte za početne resurse.'],
  ['Select 1 card to resource', 'Izaberi kartu za novi resurs.', 'Odaberi kartu za novi resurs.'],
  ['Confirm Resources', 'Potvrdi resurse', 'Potvrdi resurse'],
  ['Skip Resourcing', 'Preskoči resurs', 'Preskoči resurs'],
  ['Resource Step', 'Izbor resursa', 'Odabir resursa'],
  ['Choose an ability:', 'Izaberi sposobnost:', 'Odaberi sposobnost:'],
  ['Waiting for opponent to take an action or pass', 'Protivnik bira sledeću akciju.', 'Protivnik odabire sljedeću akciju.'],
  ['Waiting for opponent to choose whether to mulligan', 'Protivnik odlučuje o početnoj ruci.', 'Protivnik odlučuje o početnoj ruci.'],
  ['Waiting for opponent to choose cards to resource', 'Protivnik bira resurse.', 'Protivnik odabire resurse.'],
  ['Resolve all', 'Razreši sve'], ['Trigger', 'Aktiviraj'], ['Use ability', 'Upotrebi sposobnost'],
  ['{count} cards', '{count} karata'],
  ['{count} selected', '{count} izabrano'],
  ['Round {round}', 'Runda {round}'],
  ['Choose deck {name}', 'Izaberi špil {name}'],
  ['Opponent has {count} cards in hand', 'Protivnik ima {count} karata u ruci'],
  ['Details: {name}', 'Detalji: {name}'],
  ['Inspect card {name}', 'Pregledaj kartu {name}'],
  ['Decrease for {name}', 'Smanji za {name}'],
  ['Amount for {name}', 'Količina za {name}'],
  ['Increase for {name}', 'Povećaj za {name}'],
  ['At most {count} targets.', 'Najviše {count} ciljeva.'],
  ['Reference: {version}.', 'Referenca: {version}.'],
  ['Server unavailable ({status}).', 'Server nije dostupan ({status}).'],
  ['Saved game unavailable.', 'Sačuvana partija nije dostupna.'],
  ['COMMAND DATABASE', 'BAZA KOMANDE'], ['SOLO PLAY SYSTEM', 'SISTEM ZA SOLO IGRU'],
  ['Intro Battle: Hoth — 50 cards, 20 HP base. Uses normal deck shuffling.', 'Intro Battle: Hoth — 50 karata, baza 20 HP. Igra se uz uobičajeno mešanje špila.', 'Intro Battle: Hoth — 50 karata, baza 20 HP. Igra se s uobičajenim miješanjem špila.'],
];


const serverCopy: Array<[string, string, ...string[]]> = [
  [
    "Cadet",
    "Kadet",
    "Kadet"
  ],
  [
    "Knight",
    "Vitez",
    "Vitez"
  ],
  [
    "Master",
    "Majstor",
    "Majstor"
  ],
  [
    "Finishing the game with a base attack.",
    "Završavam partiju napadom na bazu.",
    "Završavam partiju napadom na bazu."
  ],
  [
    "Starting a sequence of attacks that can defeat the base.",
    "Započinjem niz napada koji može da sruši bazu.",
    "Otvaram niz napada koji može srušiti bazu."
  ],
  [
    "Putting pressure on the enemy base.",
    "Pritiskam protivničku bazu.",
    "Pritišćem protivničku bazu."
  ],
  [
    "Finishing the game with Overwhelm damage.",
    "Završavam partiju Overwhelm štetom.",
    "Overwhelm štetom završavam partiju."
  ],
  [
    "Removing a unit that could immediately defeat my base.",
    "Uklanjam jedinicu koja može odmah da sruši moju bazu.",
    "Uklanjam jedinicu koja može odmah srušiti moju bazu."
  ],
  [
    "Removing a threat to stop a lethal attack.",
    "Uklanjam pretnju i sprečavam završni napad protivnika.",
    "Uklanjam prijetnju i prekidam protivnički završni napad."
  ],
  [
    "Removing a Sentinel to open an attack lane.",
    "Uklanjam Sentinel da otvorim put za napad.",
    "Uklanjam Sentinel i otvaram arenu."
  ],
  [
    "Defeating an enemy unit while keeping mine alive.",
    "Uništavam protivničku jedinicu i čuvam svoju.",
    "Dobivam razmjenu i zadržavam svoju jedinicu."
  ],
  [
    "Trading a unit for a more valuable enemy threat.",
    "Menjam jedinicu za vredniju protivničku pretnju.",
    "Mijenjam jedinicu za važniju protivničku prijetnju."
  ],
  [
    "Removing a shield to prepare the next attack.",
    "Uklanjam štit da pripremim sledeći napad.",
    "Skidam štit za sljedeći napad."
  ],
  [
    "Setting up a favorable trade in the arena.",
    "Pripremam povoljnu razmenu u areni.",
    "Pripremam povoljnu razmjenu u areni."
  ],
  [
    "Looking for a legal attack.",
    "Tražim dozvoljen napad.",
    "Tražim legalan napad."
  ],
  [
    "Confirming the selected resources.",
    "Potvrđujem izabrane resurse.",
    "Potvrđujem odabrane resurse."
  ],
  [
    "Keeping cards in hand because there are enough resources.",
    "Imam dovoljno resursa; zadržavam karte u ruci.",
    "Imam dovoljno resursa; zadržavam karte u ruci."
  ],
  [
    "Resourcing the least useful card while keeping early plays.",
    "Stavljam najmanje korisnu kartu u resurse i čuvam karte za rane poteze.",
    "Resursiram najmanje korisnu kartu i čuvam ranu krivulju."
  ],
  [
    "Finishing the resource step.",
    "Završavam korak resursa.",
    "Završavam korak resursa."
  ],
  [
    "Taking a mulligan to find reliable early units.",
    "Menjam početnu ruku da pronađem pouzdane jeftine jedinice.",
    "Mijenjam ruku bez pouzdane rane krivulje jedinica."
  ],
  [
    "Keeping a hand with early units and follow-up plays.",
    "Zadržavam ruku sa jeftinim jedinicama i kartama za naredne poteze.",
    "Zadržavam ruku s ranim jedinicama i nastavkom krivulje."
  ],
  [
    "Building board presence and using resources efficiently.",
    "Razvijam jedinice na tabli i efikasno koristim resurse.",
    "Razvijam ploču i učinkovito koristim resurse."
  ],
  [
    "Playing an Ambush unit for an immediate attack.",
    "Igram Ambush jedinicu za trenutni napad.",
    "Uvodim Ambush jedinicu radi trenutačnog utjecaja na arenu."
  ],
  [
    "Playing a Sentinel to protect the base.",
    "Postavljam Sentinel da zaštitim bazu.",
    "Postavljam Sentinel da zaštitim bazu."
  ],
  [
    "Upgrading a unit to improve its attack or survival.",
    "Pojačavam jedinicu za bolji napad ili preživljavanje.",
    "Pojačavam jedinicu za bolji napad ili preživljavanje."
  ],
  [
    "Using damage that can finish the game.",
    "Koristim štetu koja može da završi partiju.",
    "Koristim štetu koja može završiti partiju."
  ],
  [
    "Using removal against a major threat.",
    "Uklanjam važnu protivničku pretnju.",
    "Koristim uklanjanje protiv važne prijetnje."
  ],
  [
    "Refilling my hand for the next actions.",
    "Dopunjavam ruku za sledeće akcije.",
    "Obnavljam ruku za sljedeće akcije."
  ],
  [
    "Deploying the leader for another ready unit and more pressure.",
    "Raspoređujem vođu kao dodatnu spremnu jedinicu za veći pritisak.",
    "Deployam vođu radi dodatne spremne jedinice i pritiska."
  ],
  [
    "Using an ability to gain an advantage.",
    "Koristim sposobnost da steknem prednost.",
    "Koristim sposobnost za dodatnu vrijednost."
  ],
  [
    "Saving the action because no card is affordable.",
    "Čuvam akciju jer nemam kartu koju mogu da platim.",
    "Čuvam akciju jer nemam kartu koju mogu platiti."
  ],
  [
    "Using an ability to play an affordable unit from hand.",
    "Koristim sposobnost da odigram jedinicu iz ruke koju mogu da platim.",
    "Sposobnošću igram dostupnu jedinicu iz ruke."
  ],
  [
    "Using an ability to refill my hand.",
    "Koristim sposobnost da dopunim ruku.",
    "Sposobnošću obnavljam ruku."
  ],
  [
    "Claiming initiative to act first next round.",
    "Preuzimam inicijativu za prvi potez u sledećoj rundi.",
    "Uzimam inicijativu za prvi potez sljedeće runde."
  ],
  [
    "Passing because there is no useful legal action.",
    "Preskačem jer nemam koristan dozvoljen potez.",
    "Prolazim jer nemam koristan legalan potez."
  ],
  [
    "Taking an available legal action.",
    "Koristim dostupnu dozvoljenu akciju.",
    "Koristim dostupnu legalnu akciju."
  ],
  [
    "Choosing a unit that can be paid for and played now.",
    "Biram jedinicu koju mogu da platim i odmah odigram.",
    "Biram jedinicu koju mogu platiti i odmah razviti."
  ],
  [
    "Choosing the option that loses the least value.",
    "Biram opciju sa najmanjim gubitkom vrednosti.",
    "Biram najmanji gubitak vrijednosti."
  ],
  [
    "Healing the friendly target in the most danger.",
    "Lečim najugroženiji sopstveni cilj.",
    "Liječim najugroženiji vlastiti cilj."
  ],
  [
    "Strengthening the friendly target with the greatest impact.",
    "Pojačavam sopstveni cilj sa najvećim uticajem.",
    "Pojačavam vlastiti cilj s najvećim utjecajem."
  ],
  [
    "Minimizing the loss from a required choice.",
    "Smanjujem gubitak pri obaveznom izboru.",
    "Smanjujem gubitak pri obaveznom odabiru."
  ],
  [
    "Targeting the greatest enemy threat.",
    "Ciljam najveću protivničku pretnju.",
    "Ciljam najveću protivničku prijetnju."
  ],
  [
    "Choosing the card that best supports my hand and planned plays.",
    "Biram kartu koja najbolje dopunjuje ruku i planirane poteze.",
    "Biram kartu koja najbolje dopunjuje ruku i krivulju."
  ],
  [
    "Choosing the best available legal target.",
    "Biram najbolji dostupan dozvoljeni cilj.",
    "Biram najbolji dostupni legalni cilj."
  ],
  [
    "Canceling an option that cannot be completed.",
    "Odustajem od opcije koju nije moguće sprovesti.",
    "Odustajem od neprovedive opcije."
  ],
  [
    "Skipping a choice with no useful target.",
    "Preskačem izbor bez korisnog cilja.",
    "Preskačem izbor bez korisnog cilja."
  ],
  [
    "Confirming the completed selection.",
    "Potvrđujem završen izbor.",
    "Potvrđujem dovršeni odabir."
  ],
  [
    "Continuing the planned tactical action.",
    "Nastavljam planiranu taktičku akciju.",
    "Nastavljam odabranu taktičku akciju."
  ],
  [
    "Resolving the available triggered abilities.",
    "Razrešavam dostupne pokrenute sposobnosti.",
    "Razrješavam dostupne okidače."
  ],
  [
    "Using a beneficial card effect.",
    "Koristim koristan efekat karte.",
    "Koristim korisni efekt karte."
  ],
  [
    "Declining an unnecessary extra cost.",
    "Odbijam nepotreban dodatni trošak.",
    "Odbijam nepotreban dodatni trošak."
  ],
  [
    "Choosing pressure or threat removal.",
    "Biram pritisak ili uklanjanje pretnje.",
    "Biram pritisak ili uklanjanje prijetnje."
  ],
  [
    "Choosing to draw more cards.",
    "Biram dodatno izvlačenje karata.",
    "Biram dodatne karte."
  ],
  [
    "Choosing to develop my board.",
    "Biram razvoj svojih jedinica na tabli.",
    "Biram razvoj vlastite ploče."
  ],
  [
    "Choosing healing while under pressure.",
    "Biram lečenje pod pritiskom.",
    "Biram liječenje pod pritiskom."
  ],
  [
    "Sending a less useful card to the bottom of the deck.",
    "Šaljem manje korisnu kartu na dno špila.",
    "Manje korisnu kartu šaljem na dno špila."
  ],
  [
    "Keeping a useful card for the next turn.",
    "Zadržavam korisnu kartu za sledeći potez.",
    "Zadržavam korisnu kartu za sljedeći potez."
  ],
  [
    "Choosing to act first.",
    "Biram da igram prvi.",
    "Biram prvi potez."
  ],
  [
    "Resolving a legal effect option.",
    "Razrešavam dozvoljenu opciju efekta.",
    "Razrješavam legalnu opciju efekta."
  ],
  [
    "Distributing healing among endangered targets.",
    "Raspoređujem lečenje na ugrožene ciljeve.",
    "Raspoređujem liječenje na ugrožene ciljeve."
  ],
  [
    "Distributing bonuses according to unit value.",
    "Raspoređujem pojačanja prema vrednosti jedinica.",
    "Raspoređujem pojačanja prema vrijednosti jedinica."
  ],
  [
    "Distributing indirect damage to minimize losses.",
    "Raspoređujem indirektnu štetu uz najmanji gubitak.",
    "Raspoređujem indirektnu štetu uz najmanji gubitak."
  ],
  [
    "Concentrating damage to defeat important targets.",
    "Usmeravam štetu da uklonim važne ciljeve.",
    "Koncentriram štetu za uklanjanje važnih ciljeva."
  ],
  [
    "Waiting for the opponent to act.",
    "Čekam potez protivnika.",
    "Čekam protivnički potez."
  ],
  [
    "Choosing the lowest required cost.",
    "Biram najmanji potreban trošak.",
    "Biram najmanji potreban trošak."
  ],
  [
    "Choosing the largest legal effect.",
    "Biram najveći dozvoljeni efekat.",
    "Biram najveći legalni učinak."
  ],
  [
    "There is no valid resolution for the current choice.",
    "Nema važećeg rešenja za trenutni izbor.",
    "Nema valjanog rješenja za trenutačni izbor."
  ],
  [
    "No saved game was found. Start a new game.",
    "Sačuvana partija nije pronađena. Pokreni novu partiju.",
    "Nedostaje spremljena partija. Pokreni novu partiju."
  ],
  [
    "The saved game does not match the requested game.",
    "Sačuvana partija ne odgovara traženoj partiji.",
    "Spremljena partija ne odgovara traženoj partiji."
  ],
  [
    "The previous action is still being processed.",
    "Prethodna akcija se još obrađuje.",
    "Prethodna akcija se još obrađuje."
  ],
  [
    "The game state has changed. Refresh the game before your next action.",
    "Stanje partije se promenilo. Osveži partiju pre sledeće akcije.",
    "Stanje partije se promijenilo. Osvježi partiju prije sljedeće akcije."
  ],
  [
    "The AI could not complete its decision. Try continuing the AI turn.",
    "AI nije uspeo da dovrši odluku. Pokušaj da nastaviš AI potez.",
    "AI odluka nije dovršena. Pokušaj nastaviti AI potez."
  ],
  [
    "The AI could not choose a legal action. Your game is saved; try again.",
    "AI nije uspeo da izabere dozvoljenu akciju. Partija je sačuvana; pokušaj ponovo.",
    "AI nije uspio odabrati legalnu akciju. Partija je sačuvana; pokušaj ponovno."
  ],
  [
    "Card selection",
    "Izbor karte",
    "Odabir karte"
  ],
  [
    "Decision",
    "Odluka",
    "Odluka"
  ],
  [
    "Distribution",
    "Raspodela",
    "Raspodjela"
  ],
  [
    "Effect selection",
    "Izbor efekta",
    "Odabir učinka"
  ],
  [
    "The AI action did not change the game state. Try again.",
    "AI akcija nije promenila stanje igre. Pokušaj ponovo.",
    "AI akcija nije promijenila stanje igre. Pokušaj ponovno."
  ],
  [
    "The AI reached its decision limit for this turn. Continue the AI turn.",
    "AI je dostigao ograničenje odluka za ovaj potez. Nastavi AI potez.",
    "AI je dosegnuo granicu jednog niza odluka. Nastavi AI potez."
  ],
  [
    "Official rules and errata",
    "Zvanična pravila i ispravke",
    "Službena pravila i errata"
  ],
  [
    "Fantasy Flight Games · primary source",
    "Fantasy Flight Games · primarni izvor",
    "Fantasy Flight Games · primarni izvor"
  ],
  [
    "Cover dated October 9, 2026; version note in the documentation",
    "Naslovna strana nosi datum 9. 10. 2026; napomena o verziji je u dokumentaciji",
    "Naslovnica datirana 9.10.2026.; verzijska napomena u dokumentaciji"
  ],
  [
    "SWUDB card API",
    "SWUDB API karata",
    "SWUDB API karata"
  ],
  [
    "Public JSON API; local snapshot of game card definitions",
    "Javni JSON API; lokalni snimak definicija karata za igru",
    "Javni JSON API; lokalni snapshot definicija za igru"
  ],
  [
    "Scripted rules engine · pinned project version",
    "Skriptovani sistem pravila · fiksirana verzija u projektu",
    "Skriptirani engine · fiksna verzija u projektu"
  ],
  [
    "Reddit · Ambush and When Played",
    "Reddit · Ambush i When Played",
    "Reddit · Ambush i When Played"
  ],
  [
    "Community discussion and historical interpretation; official rules take priority",
    "Diskusija zajednice i ranije tumačenje; zvanična pravila imaju prednost",
    "Rasprava zajednice, povijesno tumačenje; službena pravila imaju prednost"
  ],
  [
    "BoardGameGeek · Overwhelm and Shield",
    "BoardGameGeek · Overwhelm i Shield",
    "BoardGameGeek · Overwhelm i Shield"
  ],
  [
    "Available discussion excerpt; not an authority on the current rule",
    "Dostupan izvod iz diskusije; nije merodavan za trenutno pravilo",
    "Dostupan izvadak rasprave; nije autoritet za aktualno pravilo"
  ],
  [
    "Unknown opponent difficulty.",
    "Nepoznata težina protivnika.",
    "Nepoznata težina protivnika."
  ],
  [
    "Choose two available starter decks.",
    "Izaberi dva dostupna početna špila.",
    "Odaberi dva postojeća starter špila."
  ],
  [
    "Unknown action.",
    "Nepoznata akcija.",
    "Nepoznata akcija."
  ],
  [
    "The AI is already processing its turn.",
    "AI već obrađuje potez.",
    "AI već obrađuje potez."
  ],
  [
    "The action is still being processed.",
    "Akcija se još obrađuje.",
    "Akcija se još obrađuje."
  ],
  [
    "Unknown API route.",
    "Nepoznata API ruta.",
    "Nepoznata API ruta."
  ],
  [
    "Run npm run build, or use npm run dev for the development interface.",
    "Pokreni npm run build ili koristi npm run dev za razvojni interfejs.",
    "Pokreni npm run build, ili koristi npm run dev za razvojno sučelje."
  ],
  [
    "The available choice has changed. Refresh the game.",
    "Dostupan izbor se promenio. Osveži partiju.",
    "Odabir se promijenio. Osvježi partiju."
  ],
  [
    "The game state has changed. Refresh the game.",
    "Stanje partije se promenilo. Osveži partiju.",
    "Stanje partije se promijenilo. Osvježi partiju."
  ],
  [
    "That action is not available in the current game state.",
    "Ta akcija nije dostupna u trenutnom stanju partije.",
    "Akcija nije dostupna u trenutačnom stanju partije."
  ],
  [
    "The game has ended.",
    "Partija je završena.",
    "Partija je završila."
  ],
  [
    "The saved game is invalid. Start a new game.",
    "Sačuvana partija nije važeća. Pokreni novu partiju.",
    "Spremljena partija nije valjana. Pokreni novu partiju."
  ],
  [
    "The saved game has expired. Start a new game.",
    "Sačuvana partija je istekla. Pokreni novu partiju.",
    "Spremljena partija je istekla. Pokreni novu partiju."
  ],
  [
    "The action failed. Try again.",
    "Akcija nije uspela. Pokušaj ponovo.",
    "Akcija nije uspjela. Pokušaj ponovno."
  ],
  [
    "The game server is currently unavailable. Try again.",
    "Server igre trenutno nije dostupan. Pokušaj ponovo.",
    "Poslužitelj igre trenutačno se ne može pokrenuti. Pokušaj ponovno."
  ],
  [
    "Intro Battle: Hoth — 50 cards, 20 HP base. Played with a normally shuffled deck.",
    "Intro Battle: Hoth — 50 karata, baza sa 20 HP. Igra se sa uobičajeno promešanim špilom.",
    "Intro Battle: Hoth — 50 karata, baza 20 HP. Igra se s uobičajenim miješanjem špila."
  ]
];


const inspectorCopy: Array<[string, string, ...string[]]> = [
  ['This card is not visible to you.', 'Ova karta ti nije vidljiva.'],
  ['Back', 'Nazad'], ['Back to previous card', 'Nazad na prethodnu kartu'],
  ['Card artwork', 'Slika karte'], ['Zoom out', 'Umanji'], ['Zoom in', 'Uvećaj'],
  ['Card side', 'Strana karte'], ['Leader side', 'Strana vođe'], ['Unit side', 'Strana jedinice'], ['Front', 'Prednja strana'],
  ['Scroll or drag to explore the artwork.', 'Pomeraj sliku da pregledaš detalje.'], ['Tap artwork to zoom', 'Dodirni sliku da je uvećaš'],
  ['In play: {side}', 'U igri: {side}'], ['Aspects', 'Aspekti'],
  ['Deploy threshold', 'Prag za raspoređivanje'], ['Printed: {cost}', 'Odštampano: {cost}'],
  ['Power', 'Snaga'], ['Health', 'Život'], ['{count} damage', '{count} štete'],
  ['Current state', 'Trenutno stanje'], ['Your card', 'Tvoja karta'], ['Opponent card', 'Protivnička karta'],
  ['Card abilities', 'Sposobnosti karte'], ['Abilities', 'Sposobnosti'], ['No additional rules text.', 'Nema dodatnog teksta pravila.'],
  ['Play options', 'Načini igranja'], ['This card has no available script in the game engine.', 'Ova karta nema dostupnu skriptu u sistemu igre.'],
  ['AVAILABLE NOW', 'TRENUTNO DOSTUPNO'], ['This puts the card into your resource zone.', 'Ovo postavlja kartu u tvoju zonu resursa.'],
  ['Choose this card for the current effect.', 'Izaberi ovu kartu za trenutni efekat.'], ['Continue with this card on the battlefield.', 'Nastavi sa ovom kartom na bojištu.'],
  ['Make a resource', 'Pretvori u resurs'], ['Play this card', 'Odigraj ovu kartu'], ['Attack with this unit', 'Napadni ovom jedinicom'],
  ['Deploy this leader', 'Rasporedi ovog vođu'], ['Use this ability', 'Upotrebi ovu sposobnost'], ['Select this card', 'Izaberi ovu kartu'],
  ['Hand', 'Ruka'], ['Ground arena', 'Kopnena arena'], ['Space arena', 'Svemirska arena'], ['Discard pile', 'Odbačena hrpa'],
  ['Base zone', 'Zona baze'], ['Captured', 'Zarobljeno'], ['Outside the game', 'Van igre'], ['Unit', 'Jedinica'], ['Event', 'Događaj'], ['Upgrade', 'Nadogradnja'],
  ['Attached upgrades', 'Priključene nadogradnje'],
  ['Vigilance', 'Budnost'], ['Command', 'Komanda'], ['Aggression', 'Agresija'], ['Cunning', 'Lukavstvo'], ['Heroism', 'Herojstvo'], ['Villainy', 'Zlikovstvo'],
  ['Leader and base', 'Vođa i baza'], ['LEADER', 'VOĐA'], ['HP', 'HP'], ['base HP', 'HP baze'],
  ['Your last line of defense.', 'Tvoja poslednja linija odbrane.'], ['An official preconstructed deck, ready to play.', 'Zvanični unapred složen špil, spreman za igru.'],
  ['Deck aspects', 'Aspekti špila'], ['Deck statistics', 'Statistika špila'], ['CARDS', 'KARTE'], ['AVG. COST', 'PROS. CENA'],
  ['Resource curve', 'Kriva troškova'], ['Tap a cost to filter', 'Dodirni cenu za filtriranje'], ['Resource cost distribution', 'Raspodela troškova u resursima'],
  ['{cost} cost: {count} cards', 'Cena {cost}: {count} karata'], ['Deck contents', 'Sadržaj špila'],
  ['Search cards or rules…', 'Pretraži karte ili pravila…'], ['Search deck cards', 'Pretraži karte špila'], ['Clear search', 'Obriši pretragu'],
  ['Sort cards', 'Poređaj karte'], ['By cost', 'Po ceni'], ['By name', 'Po imenu'], ['By type', 'Po tipu'], ['Filter card type', 'Filtriraj tip karte'],
  ['All cards', 'Sve karte'], ['Units', 'Jedinice'], ['Events', 'Događaji'],
  ['{shown} of {total} cards', '{shown} od {total} karata'], ['Clear cost filter', 'Ukloni filter cene'], ['No matching cards', 'Nema odgovarajućih karata'],
  ['Try a different name, rule, type, or cost.', 'Pokušaj drugo ime, pravilo, tip ili cenu.'], ['This deck has no card list available.', 'Spisak karata ovog špila nije dostupan.'],
  ['This deck includes cards whose scripts are unavailable.', 'Špil sadrži karte čije skripte nisu dostupne.'],
  ['Use selected deck', 'Koristi izabrani špil'], ['Use this deck', 'Koristi ovaj špil'],
  ['Shielded Rebels · protect units and win efficient trades', 'Pobunjenici sa štitovima · zaštiti jedinice i ostvari povoljne razmene'],
  ['Imperial midrange · resource ramp, removal, and heavy hitters', 'Imperijalna snaga · ubrzaj resurse, uklanjaj pretnje i uvedi snažne jedinice'],
  ['Imperial tempo · efficient trades and resource ramp', 'Imperijalni tempo · povoljne razmene i ubrzan razvoj resursa'],
  ['Upgrade tempo · exhaust threats and protect key units', 'Tempo nadogradnji · iscrpljuj pretnje i štiti ključne jedinice'],
  ['Republic swarm · coordinate and clone tokens', 'Brojne jedinice Republike · koordinacija i žetoni klonova'],
  ['Droid swarm · exploit and sacrifice synergies', 'Brojni droidi · iskoristi sinergije žrtvovanja'],
  ['Indirect damage · bounty hunters and aggressive piloting', 'Indirektna šteta · lovci na ucene i agresivno pilotiranje'],
  ['Space tempo · pilots, vehicles, and surprise attacks', 'Svemirski tempo · piloti, vozila i iznenadni napadi'],
  ['Force tempo · bounce, replay, and Jedi synergies', 'Tempo Sile · vraćaj i ponovo igraj karte uz sinergije Džedaja'],
  ['Sith aggression · damage, drain, and Force units', 'Agresija Sita · šteta, iscrpljivanje i jedinice Sile'],
  ['Political control · reveal information and outlast opponents', 'Politička kontrola · otkrivaj informacije i nadživi protivnika'],
  ['Conspiracy control · discard, politics, and durable units', 'Kontrola zaverom · odbacivanje, politika i izdržljive jedinice'],
  ['Multi-aspect Rebels · build a board and coordinate attacks', 'Pobunjenici sa više aspekata · razvijaj bojište i usklađuj napade'],
  ['Underworld economy · credits, large threats, and value', 'Ekonomija podzemlja · krediti, velike pretnje i vredne akcije'],
  ['Advantage swarm · support attacks and Imperial reinforcements', 'Brojne jedinice sa Advantage · podržavaj napade i uvedi imperijalna pojačanja'],
  ['Healing midrange · support attacks and lasting board presence', 'Lečenje i razvoj · podržavaj napade i održavaj jedinice na bojištu'],
];


const catalogCopy: Array<[string, string, ...string[]]> = [
  ['Catalog snapshot: {date}. Counts include reprints and tokens.', 'Stanje kataloga: {date}. Brojevi uključuju ponovljena izdanja i žetone.'],
  ['Browse every imported printing. Open a card to read its rules; preview cards are marked.', 'Pregledaj sva uvezena izdanja karata. Otvori kartu da pročitaš njena pravila; najavljene karte su označene.'],
  ['Imported printings', 'Uvezena izdanja karata'], ['Ready to play', 'Spremno za igru'], ['Awaiting engine support', 'Čeka podršku sistema igre'],
  ['Search all cards', 'Pretraži sve karte'], ['Name, card code or rules text', 'Naziv, oznaka karte ili tekst pravila'],
  ['Set', 'Set'], ['Card set', 'Set karata'], ['All sets', 'Svi setovi'],
  ['Type', 'Tip'], ['Card type', 'Tip karte'], ['All types', 'Svi tipovi'], ['Token', 'Žeton'],
  ['Availability', 'Dostupnost'], ['Engine support', 'Podrška sistema igre'],
  ['Searching cards…', 'Pretraga karata…'], ['{count} matching printings', '{count} odgovarajućih izdanja karata'],
  ['No cards match these filters.', 'Nijedna karta ne odgovara ovim filterima.'],
  ['Inspect {card}', 'Pregledaj {card}'], ['Preview', 'Najava'], ['Needs a card script', 'Potrebna je skripta karte'], ['No engine definition', 'Nema definiciju u sistemu igre'],
  ['Card library pages', 'Stranice biblioteke karata'], ['Previous', 'Prethodna'], ['Next', 'Sledeća'], ['Page {page} of {pages}', 'Stranica {page} od {pages}'],
  ['The card library could not be loaded.', 'Biblioteka karata nije mogla biti učitana.'],
];


const customDeckCopy: Array<[string, string, ...string[]]> = [
  ['Deck input must be 100 KB or smaller.', 'Uneti špil mora biti veličine do 100 KB.'],
  ['Supported text format', 'Podržani tekstualni format'],
  ['Use section headings, then a quantity and card code on each line. Official card names are also accepted when unambiguous.', 'Koristi naslove odeljaka, pa u svakom redu navedi količinu i oznaku karte. Zvanični nazivi karata takođe se prihvataju kada su jednoznačni.'],
  ['This is an excerpt. Add the remaining cards for a main deck of at least 50 cards.', 'Ovo je deo spiska. Dodaj preostale karte da glavni špil ima najmanje 50 karata.'],
  ['Every card is recognized and its rules are supported.', 'Svaka karta je prepoznata i njena pravila su podržana.'],
  ['An imported Solo Premier deck, validated for solo play.', 'Uvezeni Solo Premier špil, proveren za solo igru.'],
  ['{count} sideboard cards are stored and validated, but are not used in this single-game match.', '{count} karata iz rezerve je sačuvano i provereno, ali se ne koriste u ovoj pojedinačnoj partiji.'],

  ['Your collection', 'Tvoja kolekcija'], ['This deck could not be removed.', 'Špil nije mogao biti uklonjen.'],
  ['Start a game with an imported deck recipe.', 'Za početak partije upotrebi uvezeni sastav špila.'],
  ['Card library', 'Biblioteka karata'], ['Import a deck', 'Uvezi špil'], ['YOUR COLLECTION', 'TVOJA KOLEKCIJA'],
  ['Import a deck or browse every available card.', 'Uvezi špil ili pregledaj sve dostupne karte.'], ['Custom decks', 'Sopstveni špilovi'], ['Stored in this browser', 'Sačuvano u ovom pregledaču'],
  ['Remove custom deck', 'Ukloni sopstveni špil'], ['Remove custom deck?', 'Ukloni sopstveni špil?'],
  ['This removes {name} from this browser. Any saved game can still be resumed.', 'Ovim se {name} uklanja iz ovog pregledača. Sačuvane partije i dalje mogu da se nastave.'],
  ['Keep deck', 'Zadrži špil'], ['Remove deck', 'Ukloni špil'], ['Deck saved to your collection.', 'Špil je sačuvan u tvojoj kolekciji.'], ['Deck removed from your collection.', 'Špil je uklonjen iz tvoje kolekcije.'],
  ['A leader, base, and main deck are required.', 'Potrebni su vođa, baza i glavni špil.'],
  ['Solo 1v1 decks require exactly one leader.', 'Solo 1 na 1 špilovi zahtevaju tačno jednog vođu.'],
  ['The sideboard must be a card list.', 'Rezerva mora biti spisak karata.'],
  ['Every card must have a set-and-number ID.', 'Svaka karta mora imati oznaku sa setom i brojem.'],
  ['Card quantities must be positive whole numbers.', 'Količine karata moraju biti pozitivni celi brojevi.'],

  ['Bring your own strategy.', 'Ponesi svoju strategiju.'],
  ['Paste a SWUDB export, a text deck list, or a public SWUDB deck link. You can also upload a JSON or TXT file.', 'Nalepi SWUDB izvoz, tekstualni spisak karata ili javni SWUDB link za špil. Možeš i učitati JSON ili TXT datoteku.'],
  ['Import progress', 'Napredak uvoza'], ['Add deck', 'Dodaj špil'], ['Validate', 'Proveri'], ['Save locally', 'Sačuvaj lokalno'],
  ['Deck name', 'Naziv špila'], ['Optional', 'Neobavezno'], ['My custom deck', 'Moj špil'],
  ['Deck export or link', 'Izvoz špila ili link'], ['JSON', 'JSON'], ['TXT', 'TXT'], ['LINK', 'LINK'],
  ['Paste your deck here…', 'Nalepi svoj špil ovde…'], ['Upload JSON / TXT', 'Učitaj JSON / TXT'], ['Clear uploaded file', 'Ukloni učitanu datoteku'], ['or drop a file here', 'ili prevuci datoteku ovde'],
  ['Text lists should identify a leader, a base, and the main deck. If a public link is unavailable, use the SWUDB JSON export.', 'Tekstualni spisak treba da navede vođu, bazu i glavni špil. Ako javni link nije dostupan, upotrebi SWUDB JSON izvoz.'],
  ['Checking cards and scripts…', 'Provera karata i skripti…'], ['Validate deck', 'Proveri špil'],
  ['Fix these issues before saving', 'Ispravi ove probleme pre čuvanja'], ['Import notes', 'Napomene o uvozu'],
  ['Your deck is ready.', 'Tvoj špil je spreman.'], ['This deck needs a few changes.', 'Ovom špilu je potrebno nekoliko izmena.'],
  ['Every card is recognized and has an available game script.', 'Svaka karta je prepoznata i ima dostupnu skriptu za igru.'],
  ['Review the details below, update your list, and validate again.', 'Pregledaj detalje ispod, izmeni spisak i proveri ga ponovo.'],
  ['CUSTOM DECK', 'SOPSTVENI ŠPIL'], ['Custom deck', 'Sopstveni špil'], ['Imported deck', 'Uvezeni špil'],
  ['main-deck cards', 'karata u glavnom špilu'], ['{count} sideboard cards', '{count} karata u rezervi'],
  ['Show fewer cards', 'Prikaži manje karata'], ['Show all {count} card entries', 'Prikaži sve zapise o kartama ({count})'], ['Missing card scripts', 'Nedostaju skripte karata'],
  ['After saving', 'Posle čuvanja'], ['Use as my deck', 'Koristi kao moj špil'], ['Use as AI deck', 'Koristi kao AI špil'], ['Save to collection only', 'Samo sačuvaj u kolekciji'],
  ['Saved in this browser. Card legality and scripts are checked again before each new game.', 'Čuva se u ovom pregledaču. Ispravnost karata i skripte proveravaju se ponovo pre svake nove partije.'],
  ['Export JSON', 'Izvezi JSON'], ['Saving…', 'Čuvanje…'], ['Save deck', 'Sačuvaj špil'], ['Edit deck list', 'Izmeni spisak karata'],
  ['Deck files must be 100 KB or smaller.', 'Datoteke špila moraju biti veličine do 100 KB.'],
  ['Choose a .json or .txt deck file.', 'Izaberi .json ili .txt datoteku špila.'], ['Deck files must be 512 KB or smaller.', 'Datoteke špila moraju biti veličine do 512 KB.'],
  ['The deck file could not be read. Try pasting its contents instead.', 'Datoteka špila nije mogla biti pročitana. Pokušaj da nalepiš njen sadržaj.'],
  ['The import response was incomplete. Please validate the deck again.', 'Odgovor na uvoz nije bio potpun. Proveri špil ponovo.'],
  ['This deck could not be imported. Try again.', 'Špil nije mogao biti uvezen. Pokušaj ponovo.'], ['This deck could not be saved.', 'Špil nije mogao biti sačuvan.'],
  ['Your browser storage is full. Export or remove a saved deck, then try again.', 'Skladište pregledača je puno. Izvezi ili ukloni sačuvani špil, pa pokušaj ponovo.'],
  ['Browser storage is unavailable. This deck has not been saved. You can export its JSON instead.', 'Skladište pregledača nije dostupno. Ovaj špil nije sačuvan. Umesto toga možeš izvesti njegov JSON.'],
  ['Each card needs a set code or an unambiguous name.', 'Svaka karta mora imati oznaku seta ili jednoznačan naziv.'],
  ['Ambiguous card name: {card}. Include its subtitle or set code.', 'Naziv karte nije jednoznačan: {card}. Dodaj podnaslov ili oznaku seta.'],
  ['Unknown card: {card}. Check the name or set code.', 'Nepoznata karta: {card}. Proveri naziv ili oznaku seta.'],
  ['Line {line}: add a Leader, Base, Main Deck, or Sideboard heading.', 'Red {line}: dodaj naslov Leader, Base, Main Deck ili Sideboard.'],
  ['Line {line}: start the card entry with a quantity, such as 3 SOR_042.', 'Red {line}: započni zapis o karti količinom, na primer 3 SOR_042.'],
  ['Use a public HTTPS deck link from swudb.com, or paste its JSON export.', 'Upotrebi javni HTTPS link za špil sa swudb.com ili nalepi njegov JSON izvoz.'],
  ['SWUDB did not respond in time. Paste its JSON export instead.', 'SWUDB nije odgovorio na vreme. Umesto toga nalepi njegov JSON izvoz.'],
  ['The SWUDB deck is private or unavailable. Paste its JSON export instead.', 'SWUDB špil je privatan ili nedostupan. Umesto toga nalepi njegov JSON izvoz.'],
  ['Deck input is too large. The limit is {limit} KB.', 'Uneti špil je prevelik. Ograničenje je {limit} KB.'],
  ['SWUDB returned an invalid deck export. Paste its JSON export instead.', 'SWUDB je vratio neispravan izvoz špila. Umesto toga nalepi njegov JSON izvoz.'],
  ['The deck JSON is invalid. Check the export and try again.', 'JSON špila nije ispravan. Proveri izvoz i pokušaj ponovo.'],
  ['SWUDB could not be reached. Paste its JSON export instead.', 'Nije moguće povezati se sa SWUDB-om. Umesto toga nalepi njegov JSON izvoz.'],
  ['The {section} section must be an array of card entries.', 'Odeljak „{section}” mora biti niz zapisa o kartama.'],
  ['A deck section may contain at most {limit} entries.', 'Odeljak špila može sadržati najviše {limit} zapisa.'],
  ['Choose exactly one {section}.', 'Izaberi tačno jednu kartu u odeljku „{section}”.'],
  ['Card quantities must be positive integers no greater than {limit}.', 'Količine karata moraju biti pozitivni celi brojevi, ne veći od {limit}.'],
  ['Paste a SWUDB JSON export, a sectioned card list, or a public SWUDB deck link.', 'Nalepi SWUDB JSON izvoz, spisak karata podeljen u odeljke ili javni SWUDB link za špil.'],
  ['Start a game with an imported deck recipe, not a URL.', 'Za početak partije upotrebi uvezeni sastav špila, a ne URL.'],
  ['The deck export must be a JSON object.', 'Izvoz špila mora biti JSON objekat.'],
  ['Solo Premier uses one leader. Twin Suns decks are not supported.', 'Solo Premier koristi jednog vođu. Twin Suns špilovi nisu podržani.'],
  ['The main deck may contain at most {limit} cards in this app.', 'Glavni špil u ovoj aplikaciji može sadržati najviše {limit} karata.'],
  ['The sideboard may contain at most 10 cards.', 'Rezerva može sadržati najviše 10 karata.'], ['Choose exactly one leader and one base.', 'Izaberi tačno jednog vođu i jednu bazu.'],
  ['Card scripts or verified data are unavailable for {card} ({code}).', 'Skripte ili provereni podaci nisu dostupni za {card} ({code}).'],
  ['This deck does not meet the deck-building rules.', 'Ovaj špil ne zadovoljava pravila za sastavljanje špila.'],
  ['Solo Premier uses all available sets; tournament rotation and suspensions are not checked.', 'Solo Premier koristi sve dostupne setove; turnirska rotacija i zabrane karata se ne proveravaju.'],
  ['Sideboard cards are validated but are not used in this single-game match.', 'Karte u rezervi se proveravaju, ali se ne koriste u ovoj pojedinačnoj partiji.'],
  ['leader', 'vođa'], ['base', 'baza'], ['deck', 'glavni špil'], ['sideboard', 'rezerva'],
];

const translations = new Map<string, { en: string; sr: string }>();
for (const [en, sr, ...aliases] of [...copy, ...inspectorCopy, ...catalogCopy, ...customDeckCopy, ...serverCopy]) for (const key of [en, ...aliases]) translations.set(key, { en, sr });

// Anchored templates cover variable prompts and legacy checkpoints without
// replacing fragments of official card names or ability text.
const templates: Array<[RegExp, (match: RegExpMatchArray, locale: Language) => string]> = [
  [/^Ambiguous card name: (.+)\. Include its subtitle or set code\.$/, (m, locale) => locale === 'en' ? m[0] : `Naziv karte nije jednoznačan: ${m[1]}. Dodaj podnaslov ili oznaku seta.`],
  [/^Unknown card: (.+)\. Check the name or set code\.$/, (m, locale) => locale === 'en' ? m[0] : `Nepoznata karta: ${m[1]}. Proveri naziv ili oznaku seta.`],
  [/^Card scripts or verified data are unavailable for (.+) \(([^()]+)\)\.$/, (m, locale) => locale === 'en' ? m[0] : `Skripte ili provereni podaci nisu dostupni za ${m[1]} (${m[2]}).`],

  [/^Unknown card ID: (.+)\.$/, (m, locale) => locale === 'en' ? m[0] : `Nepoznata oznaka karte: ${m[1]}.`],
  [/^(.+) cannot be used in the (main deck or sideboard|leader|base) slot\.$/, (m, locale) => locale === 'en' ? m[0] : `${m[1]} ne može da se koristi u odeljku „${m[2] === 'main deck or sideboard' ? 'glavni špil ili rezerva' : t(m[2])}”.`],
  [/^(.+) has incomplete preview data and is not available for play\.$/, (m, locale) => locale === 'en' ? m[0] : `${m[1]} ima nepotpune podatke iz najave i nije dostupna za igru.`],
  [/^(.+) is not fully scripted in this engine\.$/, (m, locale) => locale === 'en' ? m[0] : `${m[1]} nije potpuno skriptirana u ovom sistemu igre.`],
  [/^The (leader|base) slot must contain exactly one card\.$/, (m, locale) => locale === 'en' ? m[0] : `Odeljak „${t(m[1])}” mora sadržati tačno jednu kartu.`],
  [/^(.+) allows at most (\d+) copies across the main deck and sideboard; received (\d+)\.$/, (m, locale) => locale === 'en' ? m[0] : `${m[1]} dozvoljava najviše ${m[2]} primeraka ukupno u glavnom špilu i rezervi; uneto je ${m[3]}.`],
  [/^(.+) requires at least (\d+) main-deck cards; received (\d+)\.$/, (m, locale) => locale === 'en' ? m[0] : `${m[1]} zahteva najmanje ${m[2]} karata u glavnom špilu; uneto je ${m[3]}.`],

  [/^(Unselect resource|Resource|Deploy|Use ability on|Select|Target):? (.+)$/, (m, locale) => locale === 'en' ? m[0] : `${({ 'Unselect resource': 'Poništi izbor resursa', Resource: 'Resurs', Attack: 'Napadni', Deploy: 'Rasporedi', 'Use ability on': 'Upotrebi sposobnost karte', Select: 'Izaberi', Target: 'Izaberi cilj' } as Record<string, string>)[m[1]]}: ${m[2]}`],
  [/^(?:Deck|Špil) (.+) (?:contains unsupported cards|sadrži nepodržane karte)\.$/, (m, locale) => locale === 'en' ? `Deck ${m[1]} contains unsupported cards.` : `Špil ${m[1]} sadrži nepodržane karte.`],
  [/^(?:Odaberi špil|Choose deck) (.+)$/, (m, locale) => `${locale === 'en' ? 'Choose deck' : 'Izaberi špil'} ${m[1]}`],
  [/^(\d+) (?:karata|cards)$/, (m, locale) => `${m[1]} ${locale === 'en' ? 'cards' : 'karata'}`],
  [/^(?:Protivnik ima|Opponent has) (\d+) (?:karata u ruci|cards in hand)$/, (m, locale) => locale === 'en' ? `Opponent has ${m[1]} cards in hand` : `Protivnik ima ${m[1]} karata u ruci`],
  [/^(?:Detalji|Details): (.+)$/, (m, locale) => `${locale === 'en' ? 'Details' : 'Detalji'}: ${m[1]}`],
  [/^(.+), (?:život|health) (\d+) (?:od|of) (\d+)$/, (m, locale) => locale === 'en' ? `${m[1]}, health ${m[2]} of ${m[3]}` : `${m[1]}, život ${m[2]} od ${m[3]}`],
  [/^(\d+) (?:odabrano|selected)(.*)$/, (m, locale) => `${m[1]} ${locale === 'en' ? 'selected' : 'izabrano'}${m[2]}`],
  [/^(?:Pregledaj kartu|Inspect card) (.+)$/, (m, locale) => `${locale === 'en' ? 'Inspect card' : 'Pregledaj kartu'} ${m[1]}`],
  [/^(?:Smanji za|Decrease for) (.+)$/, (m, locale) => `${locale === 'en' ? 'Decrease for' : 'Smanji za'} ${m[1]}`],
  [/^(?:Količina za|Amount for) (.+)$/, (m, locale) => `${locale === 'en' ? 'Amount for' : 'Količina za'} ${m[1]}`],
  [/^(?:Povećaj za|Increase for) (.+)$/, (m, locale) => `${locale === 'en' ? 'Increase for' : 'Povećaj za'} ${m[1]}`],
  [/^(?:Najviše|At most) (\d+) (?:ciljeva|targets)\.$/, (m, locale) => locale === 'en' ? `At most ${m[1]} targets.` : `Najviše ${m[1]} ciljeva.`],
  [/^(?:Referenca|Reference): (.+)\.$/, (m, locale) => `${locale === 'en' ? 'Reference' : 'Referenca'}: ${m[1]}.`],
  [/^(?:Poslužitelj nije dostupan|Server unavailable) \((\d+)\)\.$/, (m, locale) => locale === 'en' ? `Server unavailable (${m[1]}).` : `Server nije dostupan (${m[1]}).`],
  [/^(?:Spremljena sesija nije dostupna|Saved game unavailable)\.\s*(.*)$/, (m, locale) => `${locale === 'en' ? 'Saved game unavailable.' : 'Sačuvana partija nije dostupna.'} ${t(m[1])}`],
  [/^(?:Select|Choose) (\d+) cards? to resource$/, (m, locale) => locale === 'en' ? m[0] : `Izaberi ${m[1]} kart${m[1] === '1' ? 'u' : 'e'} za resurse`],
  [/^Waiting for (.+) to (.+)$/, (m, locale) => locale === 'en' ? m[0] : `Čekanje: ${m[1]} — ${t(m[2])}`],
  [/^Play (.+)$/, (m, locale) => locale === 'en' ? m[0] : `Odigraj ${m[1]}`],
  [/^Attack with (.+)$/, (m, locale) => locale === 'en' ? m[0] : `Napadni sa ${m[1]}`],
];

function interpolate(text: string, vars?: TranslationVariables): string {
  return vars ? text.replace(/\{(\w+)\}/g, (match, key: string) => vars[key] === undefined ? match : String(vars[key])) : text;
}
export function t(text?: string, vars?: TranslationVariables): string {
  if (!text) return '';
  const key = text.trim();
  let translated = translations.get(key)?.[language];
  if (translated === undefined) for (const [pattern, format] of templates) {
    const match = key.match(pattern);
    if (match) { translated = format(match, language); break; }
  }
  translated ??= key;
  return interpolate(text.replace(key, translated), vars);
}
export const translatePrompt = t;
export function phaseName(phase?: string): string {
  return t(({ setup: 'Setup', action: 'Action phase', actionPhase: 'Action phase', regroup: 'Regroup', regroupPhase: 'Regroup' } as Record<string, string>)[phase || ''] || phase || 'Setup');
}
export function useLanguage() {
  const selected = useSyncExternalStore(subscribe, () => language, () => 'en' as Language);
  return { language: selected, setLanguage, t };
}
