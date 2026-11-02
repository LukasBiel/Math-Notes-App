# Notatnik Matma — plan

Otwarty (nieskończony) notes do odręcznych notatek z matematyki. Web app (PWA), działa w przeglądarce w domu i na komputerze szkolnym.

## Decyzje

| Temat | Decyzja | Dlaczego |
|---|---|---|
| Platforma | Aplikacja webowa (PWA) | Zero instalacji na szkolnym komputerze; da się „zainstalować” jak program w Chrome/Edge; działa offline |
| Nacisk pióra | Pointer Events API (`pressure`) | Chrome/Edge na Windows czytają nacisk z tabletu (Wacom/XP-Pen/Huion, przy włączonym Windows Ink). Krzywa czułości z ustawień sterownika działa dalej, w apce dodatkowo suwak „czułość” |
| Silnik rysowania | Własny, Canvas 2D + `perfect-freehand` | Pełna kontrola nad cofaniem, gumką, skrótami. Excalidraw/tldraw trudno tak przerobić (tldraw ma też licencję ze znakiem wodnym) |
| Stack | Vite + TypeScript + React (tylko UI wokół płótna) + Zustand | Proste, szybkie, popularne |
| Zapis lokalny | IndexedDB (Dexie), autozapis | Nie trzeba klikać „zapisz” |
| Synchronizacja | Własny serwer: Hono (Node) + PostgreSQL, logowanie Google, local-first (IndexedDB) | Własny Hetzner + Coolify, bazy zawsze w Postgresie |
| Hosting | Hetzner + Coolify (Dockerfile), patrz DEPLOY.md | Własna infrastruktura |
| PDF | Ramki A4 → `jsPDF` (ścieżki wektorowe rysowane bezpośrednio) | Ostry tekst i linie przy dowolnym powiększeniu wydruku |

## Model danych (skrót)

- **Folder** (grupa) → **Notatka** (jedno nieskończone płótno, nazwa, data zmian)
- Notatka zawiera **elementy**: kreska (punkty + nacisk), kształt (linia, strzałka, prostokąt, okrąg, trójkąt, układ współrzędnych…), tekst/wzór, **ramka** (strona A4 do PDF, z nazwą i kolejnością)
- Historia cofania jako lista operacji (dodaj / usuń / zmień), nie kopie całego płótna

## Funkcje — co wchodzi

**Pisanie**
- Pióro z naciskiem, grubość (szybkie przełączanie 3–4 presetów), kolory (paleta + ulubione)
- Linia prosta: przytrzymaj Shift podczas rysowania **albo** „przytrzymaj pióro w miejscu na końcu kreski” → prostuje się (jak w GoodNotes)
- Zakreślacz (półprzezroczysty)
- Tło: kratka / linie / gładkie — kratka jak w zeszycie

**Gumka**
- Gumka „kreskowa” (usuwa całą dotkniętą kreskę) — szybka i przewidywalna
- Gumka „częściowa” (przecina kreskę w miejscu przetarcia)
- Przełączanie: skrót klawiszowy, przycisk na piórze (tylny koniec pióra / boczny przycisk, jeśli tablet go raportuje)

**Cofanie**
- Ctrl+Z / Ctrl+Y (Ctrl+Shift+Z) — po jednej kresce
- „Cofnij serię” (np. Alt+Z): cofa całe ostatnie słowo/wzór = kreski pisane bez dłuższej przerwy (próg np. 1 s, do ustawienia)
- Cofanie działa też dla gumki, przesuwania, zmian koloru

**Figury matematyczne**
- Odcinek, strzałka, prostokąt, okrąg/elipsa, trójkąt, wielokąt, kąt z łukiem
- Układ współrzędnych (z podziałką), oś liczbowa
- Później: wykres funkcji z wzoru, wzory LaTeX (KaTeX), linijka/kątomierz

**Zaznaczanie**
- Lasso i prostokąt zaznaczania, przesuwanie, skalowanie, kopiuj/wklej, zmiana koloru zaznaczonych

**Nawigacja**
- Przesuwanie: spacja + przeciągnięcie / środkowy przycisk / narzędzie rączka
- Zoom: Ctrl + kółko, „dopasuj wszystko”, „skocz do ramki”

**Ramki i PDF**
- Narzędzie „ramka A4” (pion/poziom), nazwy, kolejność stron
- Eksport: cała notatka (wszystkie ramki) lub wybrane ramki → PDF
- Opcja: kratka w PDF tak/nie

**Organizacja**
- Panel boczny: foldery i notatki, zmiana nazw, przeciąganie między folderami, wyszukiwarka po nazwie
- Start aplikacji = ostatnio otwarta notatka (bez szukania „boardów”)
- „Nowa notatka” jednym skrótem (np. Ctrl+N)
- Ostatnie / przypięte notatki

**Skróty**
- Wszystkie skróty do zmiany w Ustawieniach (zapisywane z kontem)
- Domyślne: P pióro, E gumka, L linia, S zaznaczanie, H rączka, 1–4 grubości, itp.

## Czego NIE robimy (na razie)
Współpraca na żywo, komentarze, karteczki, szablony Miro, rozpoznawanie pisma, AI.

## Etapy pracy

Każdy etap kończy się czymś, czego można używać i co testujesz na swoim tablecie.

0. **Test tabletu (pół dnia)** — goła strona: rysowanie z naciskiem. Sprawdzamy, czy przeglądarka widzi nacisk z Twojego tabletu, opóźnienie, przycisk/gumkę pióra. To jedyne realne ryzyko techniczne — sprawdzamy je najpierw.
1. **Rdzeń rysowania** (✔ pierwsza wersja, `npm run dev`) — nieskończone płótno, kratka, pióro z naciskiem i grubością, kolory, gumka kreskowa, Ctrl+Z/Y, przesuwanie i zoom, linia prosta z Shift.
2. **Zapis i organizacja** (✔ pierwsza wersja: klasy → tematy → notatki, typy notatek, automatyczne nazwy, Alt+N, Ctrl+K, kosz z Undo, przeciąganie między klasami, puste notatki znikają same) — autozapis w przeglądarce, foldery, nazwy, panel boczny, otwieranie ostatniej notatki.
3. **Online** (✔ wdrożone na Coolify, logowanie Google działa) — hosting + logowanie + synchronizacja (Postgres na Hetznerze). Od tego momentu wchodzisz z komputera szkolnego.
4. **Ramki i PDF** (✔ narzędzie strony F, + Page, przeciąganie strony z treścią, nazwy, pion/poziom, eksport wektorowy z miniaturami, Ctrl+P; bez stron – automatyczny podział na A4) — ramki A4, eksport wektorowy.
5. **Figury i zaznaczanie** (✔ odcinek, strzałka, prostokąt, okrąg, trójkąt, kąt z miarą, układ współrzędnych, oś liczbowa; lasso/klik, przesuwanie, skalowanie, kolor, kopiuj/wklej/duplikuj) — zostało: prostowanie przez przytrzymanie.
6. **Wygoda** — edycja skrótów, gumka częściowa, zakreślacz, PWA/offline. (✔ „cofnij serię” – Alt+Z, zrobione w etapie 1)
7. **Dodatki (opcjonalnie)** — wzory LaTeX, wykresy funkcji, linijka/kątomierz. (✔ wklejanie obrazków Ctrl+V, zmiana rozmiaru stron, import PDF do pisania po nim – Ctrl+O / przeciągnięcie pliku)

## Ustalenia
- Pióro działa jako mysz (bez Windows Ink) – tak jest wygodniej. Domyślnie stała grubość + wygładzanie; nacisk to opcja (przycisk „Nacisk”), działa tylko z Windows Ink
- Tablet: Huion (model do sprawdzenia). Pióra Huion zwykle nie mają gumki na końcu → gumka pod skrót / przycisk boczny
- Udostępnianie: brak linków, uczniowie dostają tylko PDF-y → prosta baza, każdy widzi tylko swoje
- Logowanie: Google (Google Identity Services, weryfikacja tokenu na własnym serwerze, lista dozwolonych e-maili)
- Szkoła: Edge, bez znanych blokad → docelowo testujemy w Edge
