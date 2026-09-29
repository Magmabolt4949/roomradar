# Prompt for Claude Code

Paste this into Claude Code from the project root to continue development.

---

You're working on **RoomRadar**, a real-time networking app for mixers and club events (Node 18+, Express, Socket.IO, better-sqlite3, vanilla ES-module front end with no build step). Read `README.md` first for the architecture and design decisions.

Ground rules:
- Keep all SQL in `src/db.js` and keep `src/matching.js` pure (no I/O).
- Run `npm test` after every change; add tests for new behaviour in `test/`.
- Front end: keep the name-badge design system in `public/styles.css` (paper-blue background, ink text, highlighter-yellow reasons, one badge colour per person). Mobile-first; sentence-case copy; no new frameworks.
- Never expose an attendee's `contact` or `token` in any response other than their own or after a mutual wave.

Tasks, in order:
1. **Organiser introductions.** On the dashboard, let the organiser pick two present attendees and send both a notification: "The organiser thinks you two should meet" with the match reasons. Add an endpoint, a Socket.IO event and a test.
2. **Meet-up nudge.** After a mutual wave, offer both people "Meet at <area> in 5 minutes?" with one tap to accept, which shows on both screens.
3. **Ticket import.** Let organisers upload a CSV (name, email, role, organisation) before the event; pre-created attendees check in with a one-tap link that pre-fills their profile.
4. **Post-event summary.** An endpoint returning each attendee's connections and a printable page listing them.
5. **Deployment.** Add a `Dockerfile` and a `render.yaml`, with `DB_FILE` on a persistent disk.

After each task, update the README's feature table and test count.
