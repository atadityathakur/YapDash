# Quorum

Live quiz rooms. A host builds a quiz, shares a 6-digit room code, players join from any device with a name, answer in real time, and a leaderboard shows at the end.

## Run it

Requires Node 18 or newer.

    npm install
    npm start

Open http://localhost:3000. The terminal also prints a network address (for example http://192.168.1.20:3000). Players on the same Wi-Fi can open that address on their phones.

## Make it public (so anyone can join)

Quorum is one Node process with WebSockets, so it needs a host that runs Node (not a static host like GitHub Pages or Netlify).
Any of these work on a free or low-cost plan: Render, Railway, Fly.io, or a small VPS.

- Build command: `npm install`
- Start command: `npm start`
- The server reads the `PORT` environment variable.
- Use a single instance. Rooms live in memory, so scaling to several instances would split players across servers.
- Health check path: `/healthz`

HTTPS is picked up automatically (the page switches to `wss://` when served over https).

## How it works

- Host: Create a quiz (or paste questions in bulk), press **Host live**, share the code or the invite link.
- Players: enter the room code and a name. Reconnecting after a refresh restores their score.
- Scoring: 500 to 1000 points for a correct answer, depending on how quickly it was submitted, plus a streak bonus of 50 per consecutive correct answer (capped at 250). The server keeps the clock.
- Rounds end early once every connected player has answered.
- At the end: podium, full standings, per-question accuracy, CSV download, and "Play again with the same players".

## Bulk question format

    What is the capital of France?
    A) Berlin
    B) Paris *
    C) Madrid

    Which planet is closest to the Sun?
    A) Mercury
    B) Venus
    Answer: A

Separate questions with a blank line. Mark the correct option with `*` or an `Answer:` line.

## Notes

- Quizzes you create are saved in the host's browser (localStorage). Clearing site data removes them. Use **Copy as text** in the editor to keep a backup.
- Rooms are held in server memory and removed after 3 hours of inactivity, or if the server restarts.
- Limits: 400 players per room, 100 questions per quiz, 4 options per question.
