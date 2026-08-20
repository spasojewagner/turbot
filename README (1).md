# TurBot

RAG asistent za pretragu cenovnika turističke agencije. Odgovara na pitanja o
cenama, terminima i sadržaju aranžmana na osnovu PDF dokumenata, i uz svaki
odgovor navodi iz kog dokumenta je podatak.

Kada podatka nema, kaže to umesto da ga izmisli.

---

## Sadržaj

- [Kako radi](#kako-radi)
- [Embeddings i vektorska pretraga](#embeddings-i-vektorska-pretraga)
- [Modeli i troškovi](#modeli-i-troškovi)
- [Pokretanje](#pokretanje)
- [Skripte](#skripte)
- [Šta je mereno i popravljeno](#šta-je-mereno-i-popravljeno)
- [Poznata ograničenja](#poznata-ograničenja)

---

## Kako radi

```
pitanje
   │
   ├─ brzi ruter (regex, bez poziva modelu)
   │     └─ jasno? → namera
   │     └─ nejasno? → ruter model (flash-lite)
   │
   ├─ namera: razgovor / van_teme
   │     └─ kratak odgovor, bez pretrage, bez izvora
   │
   └─ namera: cenovnik / nastavak
         ├─ preformulisanje u samostalno pitanje (ako je nastavak)
         ├─ embedding pitanja
         ├─ vektorska pretraga (k=12)
         ├─ prag sličnosti (≥0.62)
         ├─ ograničenje po dokumentu (2–4, zavisno od pitanja)
         └─ odgovor sa navedenim izvorima (streaming)
```

Klijent dobija NDJSON stream: statuse faza, izvore čim su poznati, pa tekst
token po token.

### Slojevi

| Putanja | Uloga |
|---|---|
| `lib/rag/format.ts` | čiste funkcije — rutiranje, filtriranje, formatiranje |
| `utils/makechain.ts` | promptovi, modeli, orkestracija toka |
| `pages/api/chat.ts` | HTTP sloj, rate limiting, streaming |
| `hooks/useChat.ts` | čitanje streama, stanje razgovora |
| `scripts/` | ingestija, OCR, dijagnostika |

Sve u `lib/` je bez mrežnih poziva i pokriveno jediničnim testovima.

---

## Embeddings i vektorska pretraga

### Ingestija

PDF dokumenti se dele na fragmente od **1400 znakova sa preklapanjem od 250**.
Ta veličina nije proizvoljna — sa ranijih 800 znakova tabele sa cenama su se
sekle tako da cena završi u jednom fragmentu, a naziv hotela i termin u drugom.
Model je onda dobijao broj bez konteksta.

Svaki fragment dobija embedding preko `gemini-embedding-001` i upisuje se u
Pinecone.

**ID fragmenta je sha256 od izvora, pozicije i sadržaja.** Zbog toga je
ponovljena ingestija idempotentna — isti sadržaj prepisuje isti zapis umesto
da pravi duplikat.

### Pretraga

Kosinusna sličnost nad 3072-dimenzionim vektorima. Tri filtera se primenjuju
na rezultate, tim redom:

**Prag sličnosti (0.62).** Vektorska pretraga uvek vrati tačno `k` rezultata,
ma koliko loši bili. Bez praga je pitanje „koliko je 2+2" dobijalo osam
cenovnika kao „izvore". Vrednost je izmerena na ovom korpusu — dobri pogoci
su 0.73–0.78.

**Ograničenje po dokumentu (2–4).** Bez njega pitanje o jednoj destinaciji
vrati osam fragmenata istog PDF-a. Granica je prilagodljiva: pitanje o jednoj
destinaciji traži dubinu, široko pitanje traži pokrivenost.

**Budžet konteksta (14.000 znakova).** Gornja granica onoga što ide modelu.

### Zašto ne samo pretraga

Retrieval sam po sebi ne rešava dva problema.

Follow-up pitanja — „a koliko to košta" nema upotrebljiv signal za vektorsku
pretragu. Zato postoji korak koji ga prepisuje u samostalno pitanje koristeći
istoriju.

Pitanja van teme — bez rutiranja bi svako pitanje išlo u pretragu i dobijalo
odgovor iz cenovnika, uključujući i ona koja s njim nemaju veze.

---

## Modeli i troškovi

| Uloga | Model | Zašto |
|---|---|---|
| Odgovor | `gemini-3.6-flash` | tabelarni cenovnici traže jači model — lite varijanta ne nalazi cene u tabelama |
| Ruter i sažimanje | `gemini-3.1-flash-lite` | klasifikacija ne traži kvalitet; sa glavnim modelom je dodavala ~20s po zahtevu |
| OCR skeniranih PDF-ova | `gemini-3.6-flash` | čita PDF direktno, bez renderovanja u slike |
| Embeddings | `gemini-embedding-001` | 3072 dimenzije |

Svi su podesivi kroz env varijable, bez izmene koda. To je bilo neophodno —
Google gasi modele agresivno, i projekat je već jednom bio mrtav zato što su
`gemini-1.5-flash` i `text-embedding-004` ugašeni.

### Potrošnja

**Ingestija je jednokratna.** 431 fragment × ~1400 znakova ≈ 600.000 znakova
embedovanja. Ponavlja se samo pri promeni dokumenata ili embedding modela.

**Po pitanju:**

| Korak | Poziva | Napomena |
|---|---|---|
| brzi ruter | 0 | regex heuristika |
| ruter model | 0 ili 1 | samo kada heuristika nije sigurna |
| sažimanje istorije | 0 ili 1 | tek posle 5 razmena |
| embedding pitanja | 1 | zanemarljivo |
| odgovor | 1 | do 14k znakova ulaza, do 8k tokena izlaza |

Većina pitanja troši **jedan poziv glavnom modelu**. Pre uvođenja brzog rutera
trošila su dva, što je na free tieru sa 20 zahteva dnevno značilo sedam pitanja
umesto dvadeset.

### Free tier ograničenja

`gemini-3.6-flash` na besplatnom nivou ima **20 zahteva dnevno**. To je
dovoljno za razvoj, ne i za korišćenje. Za rad je potreban plaćeni nivo ili
prelazak na model sa većom kvotom.

Aktuelne cene i kvote: [ai.google.dev/gemini-api/docs/rate-limits](https://ai.google.dev/gemini-api/docs/rate-limits)

---

## Pokretanje

```bash
npm ci
cp .env.example .env.local   # popuni ključeve
npm run doctor               # provera konfiguracije
npm run dev
```

### Env varijable

```dotenv
GEMINI_API_KEY=
PINECONE_API_KEY=
PINECONE_INDEX_NAME=
PINECONE_NAMESPACE=

# opciono — vrednosti ispod su podrazumevane
CHAT_MODEL=gemini-3.6-flash
UTILITY_MODEL=gemini-3.1-flash-lite
EMBEDDING_MODEL=gemini-embedding-001
RETRIEVAL_K=12
RELEVANCE_FLOOR=0.62
CHUNK_SIZE=1400
CHUNK_OVERLAP=250
```

### Pinecone index

Serverless, **3072 dimenzije**, metrika **cosine**. Dimenzije moraju odgovarati
embedding modelu — promena modela znači nov index i punu re-indeksaciju.

### Prvo punjenje

```bash
npm run ocr      # samo skenirani PDF-ovi, keširа rezultat
npm run ingest
```

---

## Skripte

| Komanda | Šta radi |
|---|---|
| `npm run doctor` | provera env varijabli, Pinecone indeksa i dostupnih modela |
| `npm run pdf-doctor` | merenje kvaliteta ekstrakcije, bez API poziva |
| `npm run ocr` | čitanje skeniranih PDF-ova preko modela |
| `npm run ingest` | ingestija u Pinecone |
| `npm run test:run` | jedinični testovi |
| `npm run type-check` | provera tipova |

Dijagnostičke skripte postoje zato što se većina problema u RAG sistemu ne
vidi iz koda. `doctor` je prva stvar koju treba pokrenuti kad nešto ne radi.

---

## Šta je mereno i popravljeno

Projekat je pisan sredinom 2025, pa oživljen i prerađen godinu dana kasnije.

| | pre | posle |
|---|---|---|
| upotrebljivih dokumenata | 30/34 | 34/34 |
| fragmenata u indeksu | 737 | 431 |
| poziva modelu po pitanju | 2–3 | 1–2 |
| vreme odgovora | 60–75s | streaming, prvi token za nekoliko sekundi |
| jediničnih testova | 0 | 34 |

### Ključne izmene

**Bezbednost.** API ključevi su bili hardkodovani u izvornom kodu javnog repoa.
CI sada pada ako neko pokuša da ih vrati.

**Modeli.** Migracija sa ugašenih `gemini-1.5-flash` i `text-embedding-004`.
Nazivi modela izmešteni u env varijable.

**Kvalitet odgovora.** Pet prompt „ličnosti" zamenjeno jednim neutralnim.
Fragmenti su se sekli na 250 znakova iako su indeksirani na 800 — modelu je
stizala trećina konteksta.

**Rutiranje.** Pitanje „koliko je 2+2" je vraćalo cene za Amsterdam, jer je
korak preformulisanja svako pitanje gurao u okvir cenovnika.

**Ekstrakcija.** Četiri cenovnika su bile skenirane slike bez tekstualnog
sloja — davale su 2 do 10 znakova po strani. Sada se čitaju preko modela.

### Šta merenje nije potvrdilo

Pretpostavka da je izvučeni tekst izlomljen („Ri m avi on") je oborena —
prosečna izlomljenost je 1.2%, što je normalan srpski tekst. Planirani
post-procesor nije napisan jer problem ne postoji.

Isto tako, „deset fajlova koji se ne učitavaju" je bila greška u brojanju.
U `docs/` ima 34 fajla, ne 44.

---

## Poznata ograničenja

**Dokumenti su u repou.** `docs/` sadrži PDF cenovnike, a `public/` medijske
fajlove. To znači da dodavanje dokumenta traži commit i redeploy, i da repo
nosi binarni sadržaj. Rešenje je object storage sa metadata tabelom — nije
implementirano.

**Protivrečnosti u izvorima.** Isti podatak ume da se razlikuje između dva
cenovnika — gradska taksa za Rim je 6 € u jednom, 4 € u drugom. Sistem ih
prikazuje oba sa naznakom porekla, umesto da bira jedan.

**Cenovnici sa više aranžmana.** Fajlovi koji sadrže desetak ponuda ponekad
daju cenu bez tačnog termina, jer se lome između fragmenata.

**Nema observability.** Nema tracinga ni strukturiranog logovanja.

**Rate limiting je u memoriji.** Radi samo dok je ista serverless instanca
topla. Za produkciju treba Redis.

---

## Eval

`evals/EVAL.md` sadrži skup od pedesetak pitanja u osam kategorija za proveru
kvaliteta pre i posle izmene prompta ili parametara.

Najvrednija je kategorija sa lažnim pretpostavkama — pitanja tipa „rekli ste
da Malta košta 400 €, je l' tako?". Model koji se složi sa korisnikom da mu ne
bi protivrečio je opasan tamo gde se donose odluke o novcu.
