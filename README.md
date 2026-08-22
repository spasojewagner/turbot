[![CI](https://github.com/spasojewagner/turbot/actions/workflows/ci.yml/badge.svg)](https://github.com/spasojewagner/turbot/actions)

# TurBot

RAG asistent za pretragu cenovnika turističke agencije. Odgovara na pitanja o
cenama, terminima i sadržaju aranžmana na osnovu PDF dokumenata, i uz svaki
odgovor navodi iz kog cenovnika je podatak.

Kada podatka nema, kaže to umesto da ga izmisli.

**Uživo:** [turbot-iota.vercel.app](https://turbot-iota.vercel.app)

---

## Šta radi

Pitanje: *„Koliko košta Rim avionom tri noćenja?"*

Odgovor: cena 699 € po osobi, termin 02.05–05.05.2025, letovi JU 402 i JU 401
sa vremenima, aerodromske takse 77 evra, šta je uključeno u cenu, i klikabilan
izvor koji vodi do odlomka iz kog je podatak izvučen.

Pitanje: *„Imate li putovanje na Mont Everest?"*

Odgovor: nema u cenovnicima. Bez izmišljanja i bez nabrajanja nepovezanih
aranžmana.

Pitanje: *„Rekli ste da Malta košta 400 €, je l' tako?"*

Odgovor: ispravka. Ta cena ne postoji u izvorima; evo koje postoje.

---

## Sadržaj

- [Arhitektura](#arhitektura)
- [Embeddings i vektorska pretraga](#embeddings-i-vektorska-pretraga)
- [Upravljanje dokumentima](#upravljanje-dokumentima)
- [Modeli i troškovi](#modeli-i-troškovi)
- [Pokretanje](#pokretanje)
- [Skripte i rute](#skripte-i-rute)
- [Šta je mereno](#šta-je-mereno)
- [Poznata ograničenja](#poznata-ograničenja)

---

## Arhitektura

```
pitanje
   │
   ├─ brzi ruter (regex, bez poziva modelu)
   │     ├─ jasno?    → namera
   │     └─ nejasno?  → ruter model
   │
   ├─ namera: razgovor / van teme
   │     └─ kratak odgovor, bez pretrage, bez izvora
   │
   └─ namera: cenovnik / nastavak
         ├─ preformulisanje u samostalno pitanje (ako je nastavak)
         ├─ embedding pitanja
         ├─ vektorska pretraga (k = 12)
         ├─ prag sličnosti (>= 0.62)
         ├─ leksičko rerankiranje
         ├─ ograničenje po dokumentu (2 do 4)
         └─ odgovor sa izvorima, streamovan
```

Klijent dobija NDJSON stream: statuse faza, izvore čim su poznati, pa tekst
deo po deo. Prekid stvarno prekida obradu na serveru, ne samo prikaz.

### Slojevi

| Putanja | Uloga |
|---|---|
| `lib/env.ts` | konfiguracija, validirana Zod šemom pri učitavanju |
| `lib/logger.ts` | strukturirano logovanje sa ID-jem zahteva |
| `lib/rag/format.ts` | čiste funkcije: rutiranje, rerankiranje, filtriranje |
| `lib/documents/` | registar cenovnika nad Vercel Blob-om, ingestija |
| `utils/makechain.ts` | promptovi, modeli, orkestracija |
| `pages/api/chat.ts` | HTTP sloj, rate limiting, streaming |
| `hooks/useChat.ts` | čitanje streama, stanje razgovora |
| `scripts/` | dijagnostika i ingestija iz komandne linije |

Sve u `lib/rag/` je bez mrežnih poziva i pokriveno sa 47 jediničnih testova.

### Frontend

Dve površine sa različitim poslom. Landing prodaje: globus sa lukovima od
Beograda do destinacija koje se **stvarno nalaze u indeksu**, pa je 3D
vizualizacija podataka a ne dekoracija. Chat radi: centrirana kolona, odgovor
punom širinom, izvori kao numerisane kartice.

Tipografija ima tri uloge: display za naslove, sans za tekst, **mono za sve
što je podatak** — cene, datume, brojeve letova. To je izvedeno iz sadržaja,
jer su cenovnici puni stringova tipa `JU 402 (12:20 / 13:55)`.

---

## Embeddings i vektorska pretraga

### Ingestija

Dokumenti se dele na fragmente od **1400 znakova sa preklapanjem od 250**.
Veličina nije proizvoljna: sa ranijih 800 tabele sa cenama su se sekle tako da
cena završi u jednom fragmentu, a naziv hotela i termin u drugom.

Svaki fragment dobija **naziv aranžmana kao zaglavlje** pre embedovanja. Bez
toga tabela `HOTEL 3*** / 549€` nema nijednu reč koja se poklapa sa pitanjem,
pa je pretraga nikada ne nađe.

ID fragmenta je sha256 od izvora, pozicije i sadržaja. Zbog toga je ponovljena
ingestija idempotentna, prekinuta se nastavlja, a brisanje dokumenta može da
ukloni tačno njegove vektore.

### Pretraga

Kosinusna sličnost nad 3072-dimenzionim vektorima, pa četiri koraka obrade:

**Prag sličnosti (0.62).** Vektorska pretraga uvek vrati tačno `k` rezultata,
ma koliko loši bili. Bez praga je pitanje „koliko je 2+2" dobijalo osam
cenovnika kao izvore. Vrednost je izmerena na ovom korpusu, gde su dobri
pogoci 0.73 do 0.78.

**Leksičko rerankiranje.** Ako pitanje traži cenu, fragmenti sa iznosom u
evrima dobijaju 0.06. Isto za datume i za nabrajanje šta je uključeno.
Dodatak je namerno mali, da vektorska sličnost ostane glavni kriterijum.

**Ograničenje po dokumentu (2 do 4).** Pitanje o jednoj destinaciji traži
dubinu, pa propušta četiri fragmenta iz istog fajla. Široko pitanje traži
pokrivenost više cenovnika, pa dva.

**Budžet konteksta (14.000 znakova).** Gornja granica onoga što ide modelu.

### Nalaz o vektorskoj sličnosti

Isto pitanje u dve formulacije davalo je različit rezultat:

| Formulacija | `topScore` | Rezultat |
|---|---|---|
| „Koliko **košta** Rim avionom tri noćenja?" | 0.785 | 699 € |
| „Koje **ponude imate** za Rim za prvi maj?" | 0.803 | bez cene |

Viši skor, lošiji odgovor. Sličnost meri koliko fragment **liči** na pitanje,
ne koliko **sadrži odgovor**. Tabela je niz brojeva i oznaka, pa gubi od
prozne rečenice o uslovima, iako je odgovor upravo u njoj.

Rerankiranje rešava taj slučaj bez poziva modelu: čista funkcija, bez
latencije i bez troška. Posle njega obe formulacije vraćaju 699 €.

### Zašto pretraga sama nije dovoljna

Follow-up pitanja nemaju upotrebljiv signal. „A koliko to košta" ne govori
vektorskoj pretrazi ništa, pa postoji korak koji ga prepisuje u samostalno
pitanje koristeći istoriju.

Pitanja van teme bi bez rutiranja išla u pretragu i dobijala odgovor iz
cenovnika, uključujući i ona koja s njim nemaju veze.

---

## Upravljanje dokumentima

`/admin` — dodavanje cenovnika, status obrade, brisanje.

Fajlovi žive u Vercel Blob-u, a stanje ingestije u JSON manifestu pored njih.
**Namerno bez baze:** pri tridesetak dokumenata i jednom administratoru,
Postgres bi bio infrastruktura koja rešava problem koji ne postoji.

Granica na kojoj to prestaje da važi zapisana je u kodu: više administratora
koji pišu istovremeno, ili nekoliko stotina dokumenata.

**Skenirani cenovnici se čitaju modelom.** Neki PDF-ovi su slike bez
tekstualnog sloja i daju po dva znaka na stranu. Za njih se ceo dokument
šalje Gemini modelu, koji izvlači strukturirane podatke. Prepis se keširа, jer
je to plaćen poziv.

**Brisanje uklanja i vektore.** Svaki dokument pamti ID-jeve svojih
fragmenata. Do uvođenja registra to nije bilo moguće — obrisani cenovnik bi
i dalje odgovarao na pitanja.

---

## Modeli i troškovi

| Uloga | Model | Zašto |
|---|---|---|
| Odgovor | `gemini-3.6-flash` | tabelarni cenovnici traže jači model; lite varijanta ne nalazi cene u tabelama |
| Ruter, sažimanje, ćaskanje | `gemini-3.1-flash-lite` | klasifikacija ne traži kvalitet; sa glavnim modelom je dodavala oko 20s po zahtevu |
| OCR skeniranih PDF-ova | `gemini-3.6-flash` | čita PDF direktno, bez renderovanja u slike |
| Embeddings | `gemini-embedding-001` | 3072 dimenzije |

Svi su podesivi kroz env varijable, bez izmene koda. To je bilo neophodno:
Google gasi modele agresivno, i projekat je već jednom bio mrtav zato što su
`gemini-1.5-flash` i `text-embedding-004` ugašeni.

### Potrošnja po pitanju

| Korak | Poziva | Napomena |
|---|---|---|
| brzi ruter | 0 | regex heuristika |
| ruter model | 0 ili 1 | samo kada heuristika nije sigurna |
| sažimanje istorije | 0 ili 1 | tek posle 5 razmena |
| embedding pitanja | 1 | zanemarljivo |
| rerankiranje | 0 | čista funkcija |
| odgovor | 1 | do 14k znakova ulaza |

Većina pitanja troši **jedan poziv glavnom modelu**. Pre uvođenja brzog rutera
trošila su dva, što je na besplatnom nivou sa 20 zahteva dnevno značilo sedam
pitanja umesto dvadeset.

### Ograničenja besplatnog nivoa

`gemini-3.6-flash` ima **20 zahteva dnevno**. Dovoljno za razvoj, ne i za
korišćenje. Za rad je potreban plaćeni nivo ili model sa većom kvotom.

---

## Pokretanje

```bash
npm ci
cp .env.example .env.local
npm run doctor
npm run dev
```

### Env varijable

```dotenv
GEMINI_API_KEY=
PINECONE_API_KEY=
PINECONE_INDEX_NAME=
PINECONE_NAMESPACE=

# upravljanje dokumentima, opciono
BLOB_READ_WRITE_TOKEN=
ADMIN_TOKEN=

# opciono, vrednosti ispod su podrazumevane
CHAT_MODEL=gemini-3.6-flash
UTILITY_MODEL=gemini-3.1-flash-lite
EMBEDDING_MODEL=gemini-embedding-001
RETRIEVAL_K=12
RELEVANCE_FLOOR=0.62
CHUNK_SIZE=1400
CHUNK_OVERLAP=250
```

Konfiguracija se validira pri učitavanju. Ako fali ključ ili je vrednost van
opsega, aplikacija pada odmah sa spiskom šta nedostaje, umesto da radi do
prvog API poziva i onda vrati grešku koja izgleda kao problem sa servisom.

### Pinecone index

Serverless, **3072 dimenzije**, metrika **cosine**. Dimenzije moraju
odgovarati embedding modelu; promena modela znači nov index i punu
re-indeksaciju.

### Prvo punjenje

Kroz `/admin`, ili iz komandne linije nad `docs/` folderom:

```bash
npm run ocr      # samo skenirani PDF-ovi, rezultat se keširа
npm run ingest
```

U repou su dva uzorka cenovnika, jedan tekstualni i jedan skenirani, da bi se
ceo lanac mogao pokrenuti bez pristupa punom korpusu.

---

## Skripte i rute

| Komanda | Šta radi |
|---|---|
| `npm run doctor` | env varijable, stanje indeksa, dostupni modeli |
| `npm run pdf-doctor` | kvalitet ekstrakcije, bez API poziva |
| `npm run ocr` | čitanje skeniranih PDF-ova preko modela |
| `npm run ingest` | ingestija iz `docs/` foldera |
| `npm run test:run` | jedinični testovi |
| `npm run type-check` | provera tipova |

Dijagnostičke skripte postoje zato što se većina problema u RAG sistemu ne
vidi iz koda. `doctor` je prva stvar koju treba pokrenuti kad nešto ne radi.

### Provera stanja

```
GET /api/health          konfiguracija, bez mrežnih poziva
GET /api/health?deep=1   plus stanje Pinecone indeksa
```

Dubinska varijanta vraća **503 ako je indeks prazan**, što je najčešći uzrok
toga da bot tvrdi da nema podataka.

---

## Šta je mereno

Projekat je pisan sredinom 2025, pa oživljen i prerađen godinu dana kasnije.

| | pre | posle |
|---|---|---|
| upotrebljivih dokumenata | 30 / 34 | 34 / 34 |
| fragmenata u indeksu | 737 | 431 |
| poziva modelu po pitanju | 2 do 3 | 1 do 2 |
| vreme do prvog odziva | 60 do 75 s | streaming, status odmah |
| jediničnih testova | 0 | 47 |
| ranjivosti u zavisnostima | 37 | 13 |

### Merenja koja su oborila pretpostavke

Ovo je deo koji je vredeo najviše.

**Izlomljen tekst.** Pretpostavka je bila da `pdf-parse` lomi reči
(„Ri m avi on"). Merenje je pokazalo prosečnu izlomljenost od 1.2%, maksimum
4.3%, što je normalan srpski tekst. Planirani post-procesor nije napisan jer
problem ne postoji.

**Deset fajlova koji se ne učitavaju.** Greška u brojanju. U `docs/` ima 34
fajla, ne 44, i svih 34 se učitava.

**Budžet tokena.** Tvrdnja da spuštanje `maxOutputTokens` sa 8192 na 4096
prepolovljava vreme, sa 33 na 17 sekundi, bila je pogrešna: kraći odgovor je
bio presečen usred rečenice, ne sažetiji. Merenje brzine bez provere da li je
izlaz kompletan ne meri ništa.

### Bug u biblioteci

`@langchain/google-genai` ne parsira odgovor `batchEmbedContents` endpointa za
`gemini-embedding-001`. Vraća prazne nizove **bez ikakve greške**, pa Pinecone
odbija upis sa `Vector dimension 0`. Ingestija zato koristi `embedQuery` i
upisuje direktno, zaobilazeći `PineconeStore.addDocuments`.

---

## Eval

`evals/EVAL.md` sadrži pedesetak pitanja u osam kategorija za proveru kvaliteta
pre i posle izmene prompta ili parametara.

Najvrednija je kategorija sa lažnim pretpostavkama, tipa „rekli ste da Malta
košta 400 €, je l' tako?". Model koji se složi sa korisnikom da mu ne bi
protivrečio je opasan tamo gde se donose odluke o novcu.

---

## Poznata ograničenja

**Dva izvora dokumenata.** `docs/` folder preko skripte i Blob preko `/admin`
trenutno rade paralelno. Dok se ne pređe u potpunosti na Blob, isti cenovnik
može biti u indeksu dvaput.

**Fajlovi dodati mimo aplikacije su nevidljivi.** Manifest zna samo za ono što
je prošlo kroz `/admin`. To je cena rešenja bez baze.

**Autentifikacija je jedan deljeni token**, ne sistem naloga.

**Protivrečnosti u izvorima.** Isti podatak ume da se razlikuje između dva
cenovnika: gradska taksa za Rim je 6 € u jednom, 4 € u drugom. Sistem ih
prikazuje oba sa naznakom porekla, umesto da bira jedan.

**Cenovnici sa više aranžmana.** Fajlovi sa desetak ponuda ponekad daju cenu
bez tačnog termina, jer se lome između fragmenata.

**Rate limiting je u memoriji.** Radi samo dok je ista serverless instanca
topla. Za produkciju treba Redis.

**Lista destinacija se održava ručno.** `DESTINATIONS` u `components/Globe.tsx`
mora da prati sadržaj korpusa.

**Veza GitHub i Vercel ne okida deploy.** Do popravke se deployuje sa
`vercel --prod`.

---

## Stack

Next.js 14 (Pages Router), TypeScript, Tailwind, three.js za globus.
LangChain, Google Gemini, Pinecone. Vitest i GitHub Actions.
Vercel za hosting i Blob za dokumente.