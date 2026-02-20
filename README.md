# Music Party Game (MVP)

Real-time multiplayer song guessing game using **YouTube embeds only** (YouTube Iframe Player API).

## Stack choice
This MVP uses **Express + Vite + Socket.IO + React + TypeScript** for the simplest robust setup:
- Single Node server for authoritative game state + Socket.IO
- Vite-powered React client
- In-memory rooms/state (no DB)

## Proposed folder structure

```txt
src/
  client/
    components/YouTubePlayer.tsx
    hooks/useSocket.ts
    App.tsx
    main.tsx
    styles.css
  server/
    index.ts
    youtube.ts
  shared/
    gameUtils.ts
    types.ts
    __tests__/gameUtils.test.ts
```

## Run locally

```bash
npm install
npm run dev
```

- Client: `http://localhost:5173`
- Server + sockets: `http://localhost:3000`

## 작업물 가지고 노는 법 (빠른 가이드)

아래 순서대로 하면 바로 결과를 볼 수 있습니다.

1. 프로젝트 루트에서 의존성 설치
2. 개발 서버 실행
3. 브라우저에서 `http://localhost:5173` 접속
4. 탭 2~3개를 열어 멀티플레이 테스트

```bash
npm install
npm run dev
```

### 실제 플레이 흐름

1. **탭 A(호스트)**: 닉네임 입력 후 `Create room`
2. 생성된 **Room Code** 확인
3. **탭 B/C(플레이어)**: 같은 Room Code + 닉네임으로 `Join room`
4. 호스트가 플레이리스트 입력 후 `Save playlist` → `Start game`
5. 플레이어들이 정답을 추측해 Enter 제출
6. 라운드마다 먼저 맞춘 1명이 점수 획득, 잠시 후 자동 다음 곡 진행

### 안 될 때 체크

- `npm install` 실패 시, 네트워크/보안 정책에서 npm 레지스트리를 차단했을 가능성이 큽니다.
- 프록시/허용 레지스트리 설정 확인 후 다시 실행해 주세요.

### Production build

```bash
npm run build
npm run start
```

## How to use
1. Open app, enter nickname.
2. Create room (host) or join with room code.
3. Host pastes playlist entries (YouTube IDs/URLs, one per line or comma-separated), sets start seconds, saves playlist.
4. Host starts game.
5. Players type guesses and press Enter.
6. First correct guess each round gets point.
7. Scoreboard auto-sorts descending.

## Example playlist input

```txt
https://www.youtube.com/watch?v=fJ9rUzIMcZQ
https://youtu.be/kXYiU_JCYtU
dQw4w9WgXcQ
```

## Implemented MVP features
- Landing: nickname + room code with create/join flows
- Lobby: player list, host badge, playlist input, start button
- In-game: embedded YouTube player, round indicator, guess input, feedback, scoreboard
- Server-authoritative rooms and scoring
- Guess normalization + matching rules with minimum length threshold
- Guess rate limit: 1 guess / 800ms per player
- Round locking + reveal + timed auto-advance
- Best-effort reconnect by nickname within 2 minutes
- Room expiration after inactivity
- Host playback resync button

## Limitations (intentional MVP)
- In-memory only; restarts wipe rooms/scores.
- Video title fetch uses YouTube oEmbed best-effort; if unavailable, falls back to video ID as answer.
- No persistent auth/anti-cheat beyond lightweight controls.

## Legal note
This project uses YouTube embeds via the **YouTube Iframe Player API** only. It does not download, rip, or extract audio/video from YouTube.
