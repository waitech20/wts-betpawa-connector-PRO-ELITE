# WTS BetPawa Local Connector — PRO ELITE Phase 2A + 2B

## Scope

Phase 2 is built **on top of the Phase 1 FINAL foundation**. Phase 1 authentication and Game Connector behavior are preserved. No login flow, credentials handling, auth selectors, or Phase 1 controls were redesigned.

### Three-page flow

1. **Page 1 — Login / Authentication**
   - Existing Phase 1 UI and strict authentication proof.
   - Only requested visual exception: the overall Phase 1 background now has a subtle blue hue.

2. **Page 2 — Game Connector**
   - Existing Phase 1 game selection/connection UI remains the entry point.
   - Choose Aviator or Fortuner Mine.
   - Server independently verifies authentication before navigation.

3. **Page 3 — Game Control & Intelligence Dashboard (Phase 2)**
   - Activates only after a verified game connection.
   - Full-screen/adaptive layout.
   - Larger typography and touch targets.
   - Live game-state values are shown only when detected from the connected game DOM.
   - DOM health and mutation/event status are shown in real time.
   - Change Game returns to Page 2 without re-login while the authenticated session remains valid.

## Phase 2A — Game Shell

- Full viewport dashboard.
- Responsive desktop/laptop/tablet/mobile layout.
- Connected game identity and game ID.
- Authentication/session status.
- Game route status.
- Playwright page status.
- Frame count.
- Change Game and Disconnect actions.
- Distinct Phase 2 blue/cyan visual environment.

## Phase 2B — Live Game State + DOM Health

### Aviator
The backend looks for currently exposed payout/multiplier DOM text and displays a detected multiplier such as `2.47x` when available. If the value is not exposed, the dashboard shows a waiting state rather than inventing a value.

### Fortuner Mine
The dashboard reports detected mine/grid/cell structure and a cell count when available. It does not infer or predict hidden mine outcomes.

### DOM Health
The monitor reports:

- GAME ROOT
- GAME FRAME
- AVIATOR PAYOUT / MULTIPLIER or FORTUNER MINE / GRID
- CANVAS
- SVG
- PAGE ROOT

It also keeps the existing server-side MISSING/RECOVERED event stream.

## Security / boundaries

This connector is for authorized account connection and monitoring. It does not predict results, guarantee winnings, or bypass CAPTCHA, MFA, rate limits, anti-bot controls, or other security protections. Credentials are not persisted or returned by the API.

## Important architecture rule

The frontend does not become the source of truth for authentication. The server remains the authentication gate. Before game navigation the server verifies the live session and blocks navigation if authentication cannot be verified.

## Test checklist

- Phase 1 login UI still behaves as before.
- Wrong credentials never produce Connected.
- Successful login produces verified authentication.
- Credentials disappear after verified login.
- No game opens automatically after login.
- Page 2 still requires an explicit game selection and Connect click.
- Server verifies authentication before every game connection.
- Correct game route is reached before GAME_CONNECTED is claimed.
- Page 3 appears only after successful game connection.
- Page 3 is readable on desktop and mobile.
- Page 3 typography is intentionally larger than Phase 1.
- Aviator live multiplier is displayed only when detected.
- Fortuner Mine structural state is displayed only when detected.
- DOM MISSING/RECOVERED events are reflected in the dashboard.
- Change Game returns to Page 2 without re-login.
- Disconnect returns to Page 1.
