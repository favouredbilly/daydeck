# DayDeck: plan your day with your hands

**DayDeck** is a seated, hands-first VR planning space for Meta Quest, built with Meta's [Immersive Web SDK](https://iwsdk.dev) (WebXR). Your tasks are physical cards on a desk in front of you. Pinch them onto your day, ask an AI planning agent for a schedule, and accept or reject each suggestion with your hands.

Built for the **Meta VR Start Developer Competition 2026**, Productivity track, New Experience division.

**Live:** https://daydeck.onrender.com (open in the Meta Quest browser and tap **Enter VR**)

## The experience (under 5 minutes, fully seated, no controllers)

0. **Guided first five minutes.** A 4-step tour in the board header, with a pointer, teaches drag, ask the agent, accept, finish. It can be skipped and is saved once done.

1. **Your desk.** Task cards sit on a rack within arm's reach. Ahead of you is the day board with **Morning / Afternoon / Evening**.
2. **Pinch and drag** a card onto the board. The target slot lights up while you drag, and the card snaps in when you let go.
3. **Ask the agent.** Pinch **Plan my day** on the left panel. The agent proposes a placement for every card as glowing ✦ AI ghost cards on the board, each with a one-line reason.
4. **You decide.** Pinch a ghost card to accept it, or use **Accept all** or **Dismiss**. The agent never moves anything without your approval.
5. **Need ideas?** Pinch **Morning routine**, **Deep work** or **Wind-down**, and the agent deals new task cards onto your rack, so you never have to type in VR.
6. **Finish things.** Drag a card onto the **Done** panel on your right. Your daily count and streak update, and your board is saved for next time.
7. **Review my day.** In the evening, pinch **Review my day**. The agent writes a short, specific recap of what you finished, archives done cards, and proposes where to carry each unfinished card **tomorrow**, again as ghost cards you accept by hand. Next visit, it welcomes you back with your streak.

## Comfort and accessibility

- **Seated, hands-only, two-foot radius:** everything is reachable without standing or controllers.
- **Tap-to-place:** pinch a card once, then pinch a slot, so no drag-and-hold is needed.
- **Aa Larger text:** scales the text on cards and panels by 20%.
- **⇄ Swap sides:** mirrors the agent and Done panels for left-handed use.
- **Calm motion:** removes pulsing, bobbing and fly animations.
- Text labels as well as colours mark the times of day; settings are saved.

**Tap-to-place:** you can also pinch a card once (it lifts and highlights) and then pinch a slot or the Done zone. No dragging is needed, which helps with limited mobility, and it works with a mouse in a desktop browser too.

## Hand interactions

| Gesture | What it does |
|---|---|
| Pinch + move (ray from your hand) | Drag a task card; the target slot highlights |
| Release pinch | Snap the card into the slot or Done zone (aimed by direction, so depth doesn't matter) |
| Quick pinch on a card, then on a slot | Tap-to-place (no dragging required) |
| Pinch or poke a button | Plan my day, Accept all, Dismiss, context chips, Start a new day |
| Pinch a ✦ ghost card | Accept that one agent proposal |

Everything sits within a two-foot radius while you're seated: the desk rack at arm's reach, the board straight ahead, and the agent and Done panels angled toward you on either side.

## The AI agent

- **Server:** `server.js` (Express) calls **Claude** (Anthropic Messages API) with **forced tool calls**:
  - `propose_plan`: places each card into morning, afternoon or evening, with a short reason.
  - `deal_cards`: suggests three concrete task cards for a context.
  - `review_day`: recaps the day and proposes tomorrow's placements for unfinished cards.
- **Human in the loop:** proposals appear as ghost cards. Nothing moves until you accept.
- **Works without AI:** if the AI is unavailable, an on-device planner (time-of-day heuristics) takes over, so the core experience stands on its own.

## Tech

- **Immersive Web SDK 1.1** (ECS on Three.js): `DistanceGrabbable` (hand pinch), `RayInteractable` + `PokeInteractable` buttons, articulated hand tracking (`handTracking: true`)
- Canvas-rendered cards and panels with a bundled Inter font for crisp text in the headset
- `localStorage` persistence: your board, daily count and streak
- Optional `?emulate` mode installs Meta's IWER emulator (Quest 3 with hands) for desktop demos and automated testing

## Run it

Requires Node.js 20.19+ or 22.12+.

```bash
npm install
npm run build
ANTHROPIC_API_KEY=sk-ant-... npm start      # http://localhost:3000
```

- On **Meta Quest:** open the hosted URL in the Quest browser and tap **Enter VR**.
- On **desktop:** open the URL and click a card, then a slot, to place it. Add `?emulate` to try the emulated VR session.
- Without `ANTHROPIC_API_KEY`, the offline planner is used.

For live development with IWSDK's managed browser and emulator: `npm run dev`.

## Deploy (Render)

`render.yaml` is included: **New → Blueprint →** choose this repo, then set `ANTHROPIC_API_KEY`.

## License

[MIT](./LICENSE)
