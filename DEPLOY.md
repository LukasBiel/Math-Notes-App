# Wdrożenie: Hetzner + Coolify + Postgres

Jedna usługa (Dockerfile): serwer Hono serwuje frontend i API `/api/*`, dane w Postgresie.

## 1. Google OAuth (jednorazowo, ~5 min)
1. https://console.cloud.google.com → nowy projekt (np. „Notatnik Matma”).
2. *APIs & Services → OAuth consent screen*: External, nazwa aplikacji, Twój e-mail. Dodaj siebie jako *test user* (albo opublikuj).
3. *Credentials → Create credentials → OAuth client ID → Web application*.
4. **Authorized JavaScript origins**:
   - `https://notatnik.twojadomena.pl` (adres z Coolify)
   - `http://localhost:5173` (do pracy lokalnej)
5. Skopiuj **Client ID** (`…apps.googleusercontent.com`). Secret nie jest potrzebny.

## 2. Coolify
1. **Postgres**: *New resource → Database → PostgreSQL*. Skopiuj *Postgres URL (internal)*.
2. **Aplikacja**: *New resource → Git repository* (repo z tym projektem), *Build pack: Dockerfile*, port **3000**, domena np. `https://notatnik.twojadomena.pl`.
3. **Zmienne środowiskowe**:
   | Nazwa | Wartość |
   |---|---|
   | `DATABASE_URL` | internal URL Postgresa z kroku 1 |
   | `GOOGLE_CLIENT_ID` | Client ID z Google |
   | `ALLOWED_EMAILS` | Twój Gmail (kilka – po przecinku). **Bez tego nikt się nie zaloguje.** |
4. Deploy. Tabele tworzą się same przy starcie. Health check: `GET /health`.

## Lokalnie
- `npm run dev` → http://localhost:5173 (frontend + API; baza PGlite w `.data/`, nic nie trzeba instalować).
- Logowanie Google lokalnie: plik `.env` w katalogu projektu z linią `GOOGLE_CLIENT_ID=…` (i opcjonalnie `ALLOWED_EMAILS=…`). Bez niego działa przycisk *Dev sign-in* (tylko poza produkcją).

## Jak działa synchronizacja
- Wszystko zapisuje się najpierw w przeglądarce (IndexedDB) – apka działa bez internetu.
- Po zalogowaniu zmiany idą na serwer ~1,5 s po edycji; pobieranie co 30 s, przy powrocie do okna i po odzyskaniu sieci.
- Konflikt (ta sama notatka zmieniona na dwóch komputerach bez synchronizacji): wygrywa nowsza wersja całej notatki.
- Widok (zoom/pozycja) i „ostatnio otwarte” są osobne dla każdego komputera.
