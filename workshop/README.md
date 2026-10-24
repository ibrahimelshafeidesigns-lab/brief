# مصمم الورشة (Shop Design App)

A phone web app for the workshop. The owner tells Claude what he wants to make (typing or speaking Egyptian Arabic),
gets 2–3 options inside the shop's rules with drawings, a cut list, sheet layouts, hardware and assembly steps, and
sends the job to a worker. Workers open the same link with their own PIN, see their jobs and move each one forward
(new → cutting → assembly → done).

## How it works

- `server.js`: a small Node server with no framework. It holds the Claude API key, asks Claude for designs as
  structured JSON (`claude-opus-5-5`, with server-side refusal fallback) and checks every part against
  `rules.json` in code: materials, sheet size, door width, drawer front height, and PVC doors. It stores jobs in
  `data/jobs.json`.
- `rules.json`: the shop rules, copied from Cabinet Maker on 24 Oct 2026. Edit it to change what Claude follows.
  The server reads it again on every request.
- `public/`: the phone app (Arabic, right to left), which can be added to the home screen.

## Run it

```
npm install
ANTHROPIC_API_KEY=sk-ant-... OWNER_PIN=1234 WORKER_PIN=5678 npm start
```

Then open http://localhost:3000 (on Windows, use `start-windows.bat` instead; see below). Use `OWNER_PIN` for the designer and `WORKER_PIN` for workers. Without `OWNER_PIN`,
anyone can use it, so keep that for local testing only.

Optional settings: `PORT` (3000), `MODEL` (`claude-opus-5-5`), `EFFORT` (`medium`; `high` gives more careful
designs but they come back slower), and `DATA_DIR` (`./data`).

Testing without a key: `MOCK_DESIGN=test/sample-design.json npm start` returns a sample bed. `npm test` checks the
rules.

## Run it on the shop computer (free)

The app runs on a Windows computer that stays on. Tailscale Funnel gives it a free, fixed `https://` link that works on
any phone. HTTPS is also what the phone's microphone needs.

1. Install Node.js LTS from nodejs.org.
2. Copy `.env.example` to `.env` in this folder and fill it in:
   - `ANTHROPIC_API_KEY`: from console.anthropic.com → API Keys → Create Key.
   - `OWNER_PIN`: the owner's code.
   - `WORKER_PIN`: the workers' code.
   `.env` is never committed (see `.gitignore`).
3. Double-click `start-windows.bat`. The first run installs the packages. The script restarts the app if it stops.
4. Install Tailscale from tailscale.com and sign in. Then, in a terminal, run `tailscale funnel --bg 3000`. It prints
   the link (`https://<computer>.<name>.ts.net`). Open that link on the phones and use "Add to Home screen".
5. To start after a restart: press Win+R, type `shell:startup`, and put a shortcut to `start-windows.bat` there.
   Funnel's `--bg` setting survives restarts by itself.

Jobs are saved in `data/jobs.json` on that computer. Back up that file now and then.
