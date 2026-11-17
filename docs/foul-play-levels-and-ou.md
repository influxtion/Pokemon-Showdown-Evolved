# Foul Play: difficulty levels and OU

## Vision

Practice should have an opponent for every skill level, and it should cover OU as well as Random Battle. Foul Play is the strongest bot on the Bots page, and the simple bots are far weaker. This adds weaker versions of Foul Play to fill that gap, and lets the player practise OU against Foul Play with teams they choose.

## Difficulty levels

The Bots page groups opponents by difficulty, hardest first:

| Group | Opponents |
| --- | --- |
| Hard | Foul Play |
| Medium (new) | Foul Play Medium, Foul Play Casual |
| Easy | Heuristic, Greedy, Random |

- **Foul Play** stays exactly as it is today.
- **Foul Play Medium** thinks for less time and is less strict about always picking its best move.
- **Foul Play Casual** thinks even less, commits to one guess about the player's team, and sometimes picks its second- or third-best move.
- Weaker levels should make believable mistakes, never random or silly moves. A player should feel the bot is beatable, not broken.
- The levels should be clearly apart: Casual should reliably beat Heuristic, Medium should beat Casual, and Hard should beat Medium.
- Every card looks the same as the existing ones. The weaker levels are Random Battle only for now.

## OU

- The OU tab on the Bots page is enabled. It lists Foul Play (Hard) only.
- **The player picks both teams:** their own team and Foul Play's team.
- Each team comes from either:
  - **My teams:** an OU team from the player's Teambuilder, or
  - **Paste a team:** a pasted Showdown export.
- The same team can be used for both sides (a mirror match).
- There are no built-in or sample teams. The player must bring a team.
- Play stays disabled until both teams are chosen. An illegal or unreadable team shows a clear reason next to that team, and the player can fix it and try again.
- The page remembers the last Teambuilder teams chosen. Pasted teams are not saved.
- A rematch keeps both teams.
- Weaker OU levels may come later, not now.

## Look and feel

- Keep the approved "B · Tiers" Bots page layout: format tabs, collapsible difficulty groups, flat cards of equal size, each with its own Play button.
- Show a mockup of the OU team picker and get approval before building it.
- No grey or purple, and nothing that looks AI-generated: no tinted icon tiles, no pill badges, no coloured status dots.
- No "unrated" wording and no computation setting.

## Must stay true

- Foul Play only ever runs on the cloud server, never inside the app.
- Practice never uses the player's Showdown account or the public server.
- Teams the player brings are private: they are used for the game and not kept or logged.

## Decided

- No Smogon or sample teams.
- Foul Play's OU set data is downloaded on the server.
- The usage stats it relies on are refreshed by hand when needed.
- The names are Foul Play Medium and Foul Play Casual.
