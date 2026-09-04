# WTS BetPawa Local Connector — PRO ELITE

Local Node.js + Playwright connector for an authorized account/session.

## Core architecture

Authentication is the root gate. The connector does **not** treat URL changes, casino routes, or a stale DOM element as login proof.

Login flow:

`LOGIN FORM → PRE-LOGIN BASELINE → FILL → SUBMIT → POST-LOGIN TRANSITION → STABLE AUTH PROOF`

A successful login requires a real post-submit transition: the login form must cease to be visible and an authenticated account indicator (profile or balance) must become visible. Two consecutive positive checks are required.

If credentials are rejected, the login form remains visible and a recognized credential error is detected. The request is marked `LOGIN_FAILED`.

If authentication cannot be strictly verified, the state remains failed/unknown. The connector never guesses success.

## Game gate

Available games:

- Aviator — `34971`
- Fortuner Mine — `35102`

Game navigation is impossible unless the server independently verifies the authenticated session immediately before navigation.

When the current game route does not expose the account chrome, the connector temporarily visits the configured BetPawa home route in the **same Playwright page/context/session**, verifies the session, and only then opens the requested game.

The frontend never uses `window.open()`.

## Change Game

After a game is connected, the UI provides `Change Game`. Selecting another game reuses the existing authenticated session and repeats the server-side authentication gate before navigation.

## DOM Watchdog

The server continuously monitors the important authentication DOM groups:

- `AUTH_PHONE`
- `AUTH_PASSWORD`
- `AUTH_LOGIN_BUTTON`
- `AUTH_PROFILE`
- `AUTH_BALANCE`
- `AUTH_ERROR`

A `MutationObserver` is also installed in the Playwright page. DOM availability changes are exposed through `/api/status` as `domEvents`.

Events are edge-based rather than spam-based:

- `MISSING` — a previously available element is no longer visible.
- `RECOVERED` — a previously missing element becomes visible again.

The frontend displays compact notifications for these events.

## API

- `GET /api/health`
- `GET /api/status`
- `POST /api/start-login`
- `GET /api/wait-login?requestId=...`
- `POST /api/connect-game`
- `POST /api/reset`

`/api/status` includes connector state, authentication proof, selected game, current URL, DOM health, DOM events and mutation version.

## Security rules

- Passwords are accepted only in memory for the login operation.
- Passwords are not logged or persisted by the connector.
- Do not put real credentials in source control or `.env.example`.
- This project does not bypass CAPTCHA, MFA, rate limits, anti-bot controls, or other security protections.

## Install

```bash
npm install
npx playwright install chromium
npm start
```

Open:

`http://127.0.0.1:3930`

## Acceptance tests

1. Correct credentials → `AUTHENTICATED`.
2. Wrong password → `LOGIN_FAILED`; never `Connected`.
3. Correct phone + wrong password while no session exists → no game navigation.
4. Direct `/api/connect-game` without authentication → HTTP 401 and no game navigation.
5. Successful login does not automatically open a game.
6. Exactly one game can be selected at a time.
7. Game connection re-verifies authentication server-side.
8. `Change Game` switches between the two configured games without a new login when the session remains valid.
9. DOM element disappearance generates a `MISSING` event notification.
10. DOM recovery generates a `RECOVERED` notification.
11. Repeated missing checks do not generate notification spam.
12. Double-click login does not start a second concurrent login request.
13. Password is never included in status responses or DOM event payloads.
