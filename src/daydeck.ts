// DayDeck: a seated, hands-first planning space with an AI agent.
//
// Layout (meters, player origin at the floor, seated head about 1.2 m):
//   - desk + card rack in front of you (within arm's reach)
//   - the day board straight ahead (Morning / Afternoon / Evening)
//   - the agent panel on the left, the Done panel on the right

import {
  BoxGeometry,
  CylinderGeometry,
  createSystem,
  DistanceGrabbable,
  Entity,
  Grabbed,
  Group,
  Hovered,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  MovementMode,
  PokeInteractable,
  Pressed,
  Quaternion,
  RayInteractable,
  Vector3,
} from '@iwsdk/core';
import { planDay, suggestTasks, type Proposal } from './agent.js';
import { DeckButton, GhostCard, TaskCard } from './daydeck-components.js';
import { C, CanvasPlane, drawButton, drawCard, FONT, roundRect, wrapText } from './draw.js';
import {
  firstFreeSlot,
  inboxTasks,
  loadState,
  markDone,
  newId,
  PART_LABEL,
  PARTS,
  saveState,
  SLOTS_PER_PART,
  type DeckState,
  type SlotPart,
  type Task,
} from './state.js';

const CARD_W = 0.34;
const CARD_H = 0.085;
const BOARD_Z = -0.84;
const COL_X: Record<SlotPart, number> = { morning: -0.46, afternoon: 0, evening: 0.46 };
const SLOT_Y0 = 1.46;
const SLOT_DY = 0.115;
const RACK_COLS = 3;
const AGENT_POS = new Vector3(-0.8, 1.2, -0.5);
const DONE_POS = new Vector3(0.8, 1.2, -0.5);
const HEAD_FALLBACK = new Vector3(0, 1.2, 0);

type Btn = { plane: CanvasPlane; entity: Entity; label: string; style: 'primary' | 'secondary' | 'chip'; hover: boolean };

function facingYaw(pos: Vector3): number {
  return Math.atan2(-pos.x, -pos.z);
}

export class DayDeckSystem extends createSystem({
  cards: { required: [TaskCard] },
  grabbedCards: { required: [TaskCard, Grabbed] },
  pressedButtons: { required: [DeckButton, Pressed] },
  hoveredButtons: { required: [DeckButton, Hovered] },
  pressedGhosts: { required: [GhostCard, Pressed] },
  pressedCards: { required: [TaskCard, Pressed] },
}) {
  private state!: DeckState;
  private cardEntities = new Map<string, Entity>();
  private cardPlanes = new Map<string, CanvasPlane>();
  private ghosts = new Map<string, { entity: Entity; part: SlotPart; index: number; reason: string }>();
  private targets = new Map<Entity, { pos: Vector3; quat: Quaternion; scale: number }>();
  private buttons = new Map<string, Btn>();
  private agentPanel!: CanvasPlane;
  private donePanel!: CanvasPlane;
  private board!: CanvasPlane;
  private agentStatus = 'Pinch “Plan my day” and I will propose a schedule. You approve every move.';
  private agentSummary = '';
  private agentSource: 'ai' | 'offline' | '' = '';
  private busy = false;
  private tmpA = new Vector3();
  private tmpB = new Vector3();
  private tmpHead = new Vector3();
  private rackQuat = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -0.32);
  private boardQuat = new Quaternion();
  private audio: AudioContext | null = null;
  private highlight = '';
  private selectedId = '';
  private grabStart = new Vector3();
  private dragPos = new Vector3();
  private slotTmp = new Vector3();

  init(): void {
    this.state = loadState();
    (window as any).__deck = this;
    this.buildEnvironment();
    this.buildBoard();
    this.buildAgentPanel();
    this.buildDonePanel();
    for (const t of this.state.tasks) if (t.place.kind !== 'done') this.spawnCard(t);
    this.layoutAll(true);

    this.queries.grabbedCards.subscribe('disqualify', (e) => this.onCardReleased(e));
    this.queries.grabbedCards.subscribe('qualify', (e) => {
      e.object3D?.getWorldPosition(this.grabStart);
      this.blip(520, 0.04);
    });
    this.queries.pressedCards.subscribe('qualify', (e) => this.toggleSelect(e.getValue(TaskCard, 'taskId') as string));
    this.queries.pressedButtons.subscribe('qualify', (e) => this.onButton(e.getValue(DeckButton, 'action') as string));
    this.queries.pressedGhosts.subscribe('qualify', (e) => this.acceptProposal(e.getValue(GhostCard, 'taskId') as string));
    this.queries.hoveredButtons.subscribe('qualify', (e) => this.setHover(e, true));
    this.queries.hoveredButtons.subscribe('disqualify', (e) => this.setHover(e, false));
  }

  update(delta: number): void {
    let dragging = false;
    for (const e of this.queries.grabbedCards.entities) {
      const o = e.object3D;
      if (!o) continue;
      dragging = true;
      this.setHighlight(this.dropTarget(o.getWorldPosition(this.dragPos)));
      break;
    }
    if (!dragging && this.highlight) this.setHighlight('');
    const k = 1 - Math.exp(-delta * 12);
    for (const [entity, t] of this.targets) {
      const o = entity.object3D;
      if (!o || entity.hasComponent(Grabbed)) continue;
      o.position.lerp(t.pos, k);
      o.quaternion.slerp(t.quat, k);
      const s = o.scale.x + (t.scale - o.scale.x) * k;
      o.scale.setScalar(s);
      if (o.position.distanceToSquared(t.pos) < 1e-7 && Math.abs(s - t.scale) < 1e-4) {
        o.position.copy(t.pos);
      }
    }
  }

  // ---------------------------------------------------------------- building

  private persistent<T extends Mesh | Group>(obj: T, parent?: Entity): Entity {
    return this.world.createTransformEntity(obj, parent ? { parent, persistent: true } : { persistent: true });
  }

  private buildEnvironment() {
    const wood = new MeshStandardMaterial({ color: 0xc9a27a, roughness: 0.6 });
    const dark = new MeshStandardMaterial({ color: 0x3a3548, roughness: 0.5 });
    const desk = new Mesh(new BoxGeometry(1.4, 0.04, 0.5), wood);
    desk.position.set(0, 0.72, -0.48);
    desk.castShadow = desk.receiveShadow = true;
    this.persistent(desk);
    for (const [x, z] of [[-0.66, -0.26], [0.66, -0.26], [-0.66, -0.7], [0.66, -0.7]]) {
      const leg = new Mesh(new CylinderGeometry(0.018, 0.018, 0.7), dark);
      leg.position.set(x, 0.35, z);
      this.persistent(leg);
    }
    // card rack: a stepped stand on the desk
    for (let r = 0; r < 3; r++) {
      const step = new Mesh(new BoxGeometry(1.2, 0.02, 0.08), dark);
      step.position.set(0, 0.745 + r * 0.07, -0.32 - r * 0.1);
      this.persistent(step);
    }
  }

  private buildBoard() {
    this.board = new CanvasPlane(1536, 768, 1.46, 0.73);
    this.board.mesh.position.set(0, 1.3, BOARD_Z - 0.01);
    this.persistent(this.board.mesh);
    const hitMat = new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
    for (const part of PARTS) {
      for (let i = 0; i < SLOTS_PER_PART; i++) {
        const hit = new Mesh(new PlaneGeometry(CARD_W + 0.02, CARD_H + 0.02), hitMat);
        this.slotPos(part, i, this.tmpA);
        hit.position.copy(this.tmpA);
        hit.position.z -= 0.006;
        const e = this.persistent(hit);
        e.addComponent(DeckButton, { action: `slot:${part}:${i}` });
        e.addComponent(RayInteractable);
      }
    }
    this.drawBoard();
  }

  private drawBoard() {
    this.board.redraw((g, w, h) => {
      roundRect(g, 4, 4, w - 8, h - 8, 36);
      g.fillStyle = 'rgba(255,255,255,0.97)';
      g.fill();
      g.font = `800 46px ${FONT}`;
      g.textBaseline = 'middle';
      g.fillStyle = C.ink;
      g.fillText('Today', 48, 56);
      g.font = `500 30px ${FONT}`;
      g.fillStyle = C.muted;
      g.fillText('Pinch a card and drag it onto your day', 210, 58);
      const colW = w / 3;
      PARTS.forEach((p, i) => {
        const cx = colW * i + colW / 2;
        g.fillStyle = C.part[p];
        g.font = `800 34px ${FONT}`;
        g.textAlign = 'center';
        g.fillText(PART_LABEL[p], cx, 128);
        g.textAlign = 'left';
        for (let s = 0; s < SLOTS_PER_PART; s++) {
          const yWorld = SLOT_Y0 - s * SLOT_DY;
          const yPx = (1 - (yWorld - (1.3 - 0.365)) / 0.73) * h;
          const sw = (CARD_W / 1.46) * w + 12;
          const sh = (CARD_H / 0.73) * h + 10;
          roundRect(g, cx - sw / 2, yPx - sh / 2, sw, sh, 22);
          if (this.highlight === `${p}:${s}`) {
            g.fillStyle = 'rgba(91,75,219,0.16)';
            g.fill();
            g.lineWidth = 7;
            g.strokeStyle = C.accent;
            g.stroke();
          } else {
            g.setLineDash([10, 10]);
            g.lineWidth = 3;
            g.strokeStyle = '#cfc8dc';
            g.stroke();
            g.setLineDash([]);
          }
        }
      });
    });
  }

  private buildAgentPanel() {
    const group = new Group();
    group.position.copy(AGENT_POS);
    group.rotation.y = facingYaw(AGENT_POS);
    const parent = this.persistent(group);
    this.agentPanel = new CanvasPlane(1024, 1180, 0.6, 0.69);
    this.persistent(this.agentPanel.mesh, parent);
    const bw = 0.5, bh = 0.07;
    this.makeButton('plan', 'Plan my day', 'primary', bw, bh, 0, -0.105, parent);
    this.makeButton('accept', 'Accept all', 'secondary', 0.24, 0.06, -0.13, -0.19, parent);
    this.makeButton('dismiss', 'Dismiss', 'secondary', 0.24, 0.06, 0.13, -0.19, parent);
    this.makeButton('ctx:Morning routine', 'Morning routine', 'chip', 0.18, 0.05, -0.19, -0.285, parent);
    this.makeButton('ctx:Deep work', 'Deep work', 'chip', 0.18, 0.05, 0, -0.285, parent);
    this.makeButton('ctx:Wind-down', 'Wind-down', 'chip', 0.18, 0.05, 0.19, -0.285, parent);
    this.drawAgentPanel();
  }

  private drawAgentPanel() {
    const proposals = [...this.ghosts.entries()];
    this.agentPanel.redraw((g, w, h) => {
      roundRect(g, 4, 4, w - 8, h - 8, 40);
      g.fillStyle = C.panel;
      g.fill();
      g.textBaseline = 'middle';
      g.fillStyle = C.accent;
      g.font = `800 50px ${FONT}`;
      g.fillText('✦ Planning agent', 48, 70);
      g.font = `600 26px ${FONT}`;
      g.fillStyle = C.muted;
      const src = this.agentSource === 'ai' ? 'Claude' : this.agentSource === 'offline' ? 'Offline planner' : '';
      if (src) g.fillText(src, w - 48 - g.measureText(src).width, 72);
      g.font = `600 38px ${FONT}`;
      g.fillStyle = C.ink;
      let y = 145;
      for (const line of wrapText(g, this.agentStatus, w - 96, 3)) {
        g.fillText(line, 48, y);
        y += 48;
      }
      if (this.agentSummary) {
        y += 6;
        g.font = `italic 500 32px ${FONT}`;
        g.fillStyle = C.muted;
        for (const line of wrapText(g, this.agentSummary, w - 96, 2)) {
          g.fillText(line, 48, y);
          y += 42;
        }
      }
      y += 14;
      g.font = `600 27px ${FONT}`;
      for (const [taskId, p] of proposals.slice(0, 6)) {
        const t = this.task(taskId);
        if (!t) continue;
        g.fillStyle = C.part[p.part];
        g.beginPath();
        g.arc(60, y, 11, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = C.ink;
        g.font = `700 32px ${FONT}`;
        const head = `${t.title} → ${PART_LABEL[p.part].toLowerCase()}`;
        g.fillText(wrapText(g, head, w - 130, 1)[0], 84, y);
        y += 38;
        g.font = `500 28px ${FONT}`;
        g.fillStyle = C.muted;
        g.fillText(wrapText(g, p.reason, w - 130, 1)[0], 84, y);
        y += 50;
        if (y > 690) break;
      }
      // divider above buttons
      g.fillStyle = '#e6e2ee';
      g.fillRect(48, h * 0.62, w - 96, 3);
      g.font = `600 30px ${FONT}`;
      g.fillStyle = C.muted;
      g.fillText('Need ideas? I can deal you cards:', 48, h * 0.86);
    });
  }

  private buildDonePanel() {
    const group = new Group();
    group.position.copy(DONE_POS);
    group.rotation.y = facingYaw(DONE_POS);
    const parent = this.persistent(group);
    this.donePanel = new CanvasPlane(1024, 1180, 0.6, 0.69);
    this.persistent(this.donePanel.mesh, parent);
    this.makeButton('reset', 'Start a new day', 'secondary', 0.3, 0.055, 0, -0.285, parent);
    const zone = new Mesh(new PlaneGeometry(0.53, 0.18), new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
    zone.position.set(0, 0.2, 0.01);
    const ze = this.persistent(zone, parent);
    ze.addComponent(DeckButton, { action: 'drop:done' });
    ze.addComponent(RayInteractable);
    this.drawDonePanel();
  }

  private drawDonePanel() {
    const s = this.state;
    const done = s.tasks.filter((t) => t.place.kind === 'done').slice(-4).reverse();
    this.donePanel.redraw((g, w, h) => {
      roundRect(g, 4, 4, w - 8, h - 8, 40);
      g.fillStyle = 'rgba(255,255,255,0.97)';
      g.fill();
      g.textBaseline = 'middle';
      g.fillStyle = C.green;
      g.font = `800 50px ${FONT}`;
      g.fillText('✓ Done', 48, 70);
      // drop zone
      roundRect(g, 48, 120, w - 96, 300, 32);
      g.fillStyle = this.highlight === 'done' ? '#bfead4' : '#e8f6ef';
      g.fill();
      g.setLineDash([16, 12]);
      g.lineWidth = 5;
      g.strokeStyle = C.green;
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = C.green;
      g.font = `700 36px ${FONT}`;
      g.textAlign = 'center';
      g.fillText('Drop a finished card here', w / 2, 270);
      g.textAlign = 'left';
      g.fillStyle = C.ink;
      g.font = `800 92px ${FONT}`;
      g.fillText(String(s.doneToday), 60, 520);
      g.font = `600 30px ${FONT}`;
      g.fillStyle = C.muted;
      g.fillText('done today', 60 + g.measureText('00').width + 70, 528);
      g.fillStyle = C.ink;
      g.font = `800 92px ${FONT}`;
      g.fillText(String(s.streakDays), 560, 520);
      g.font = `600 30px ${FONT}`;
      g.fillStyle = C.muted;
      g.fillText('day streak', 560 + 90, 528);
      let y = 650;
      g.font = `500 34px ${FONT}`;
      for (const t of done) {
        g.fillStyle = C.green;
        g.fillText('✓', 60, y);
        g.fillStyle = C.muted;
        g.fillText(wrapText(g, t.title, w - 160, 1)[0], 104, y);
        y += 52;
      }
    });
  }

  private makeButton(action: string, label: string, style: Btn['style'], w: number, h: number, x: number, y: number, parent: Entity) {
    const plane = new CanvasPlane(Math.round(w * 1400), Math.round(h * 1400), w, h);
    plane.mesh.position.set(x, y, 0.012);
    const entity = this.persistent(plane.mesh, parent);
    entity.addComponent(DeckButton, { action });
    entity.addComponent(RayInteractable);
    entity.addComponent(PokeInteractable);
    const btn: Btn = { plane, entity, label, style, hover: false };
    this.buttons.set(action, btn);
    plane.redraw((g, pw, ph) => drawButton(g, pw, ph, label, style));
  }

  private setHover(e: Entity, hover: boolean) {
    const btn = this.buttons.get(e.getValue(DeckButton, 'action') as string);
    if (!btn) return;
    btn.hover = hover;
    btn.plane.redraw((g, pw, ph) => drawButton(g, pw, ph, btn.label, btn.style, hover));
  }

  // ---------------------------------------------------------------- cards

  private task(id: string): Task | undefined {
    return this.state.tasks.find((t) => t.id === id);
  }

  private spawnCard(t: Task, from?: Vector3) {
    const plane = new CanvasPlane(1024, 256, CARD_W, CARD_H);
    this.cardPlanes.set(t.id, plane);
    this.drawTaskCard(t);
    if (from) plane.mesh.position.copy(from);
    const entity = this.persistent(plane.mesh);
    entity.addComponent(TaskCard, { taskId: t.id });
    entity.addComponent(RayInteractable);
    entity.addComponent(DistanceGrabbable, {
      movementMode: MovementMode.MoveAtSource,
      rotate: false,
      scale: false,
      translate: true,
    });
    this.cardEntities.set(t.id, entity);
  }

  private drawTaskCard(t: Task) {
    const plane = this.cardPlanes.get(t.id);
    if (!plane) return;
    const partColor = t.place.kind === 'slot' ? C.part[t.place.part] : undefined;
    const selected = this.selectedId === t.id;
    plane.redraw((g, w, h) => drawCard(g, w, h, t.title, t.minutes, { partColor, selected }));
  }

  private slotPos(part: SlotPart, index: number, out: Vector3) {
    return out.set(COL_X[part], SLOT_Y0 - index * SLOT_DY, BOARD_Z + 0.01);
  }

  private rackPos(i: number, out: Vector3) {
    const row = Math.floor(i / RACK_COLS);
    const col = i % RACK_COLS;
    return out.set((col - 1) * 0.38, 0.8 + row * 0.07, -0.3 - row * 0.1);
  }

  private setTarget(e: Entity, pos: Vector3, quat: Quaternion, scale = 1) {
    const t = this.targets.get(e);
    if (t) {
      t.pos.copy(pos);
      t.quat.copy(quat);
      t.scale = scale;
    } else this.targets.set(e, { pos: pos.clone(), quat: quat.clone(), scale });
  }

  private layoutAll(instant = false) {
    const inbox = inboxTasks(this.state);
    inbox.forEach((t, i) => {
      const e = this.cardEntities.get(t.id);
      if (!e) return;
      this.rackPos(Math.min(i, 8), this.tmpA);
      if (t.id === this.selectedId) this.tmpA.y += 0.035;
      this.setTarget(e, this.tmpA, this.rackQuat, t.id === this.selectedId ? 1.08 : 1);
    });
    for (const t of this.state.tasks) {
      if (t.place.kind !== 'slot') continue;
      const e = this.cardEntities.get(t.id);
      if (!e) continue;
      this.slotPos(t.place.part, t.place.index, this.tmpA);
      if (t.id === this.selectedId) this.tmpA.z += 0.03;
      this.setTarget(e, this.tmpA, this.boardQuat, t.id === this.selectedId ? 1.08 : 1);
    }
    if (instant) {
      for (const [e, t] of this.targets) {
        e.object3D?.position.copy(t.pos);
        e.object3D?.quaternion.copy(t.quat);
      }
    }
  }

  private headPos(out: Vector3) {
    const head = this.player?.head;
    if (!head) return out.copy(HEAD_FALLBACK);
    head.getWorldPosition(out);
    if (out.lengthSq() < 0.01) out.copy(HEAD_FALLBACK);
    return out;
  }

  /** Angle (radians) between the directions head→a and head→b. */
  private angleFromHead(a: Vector3, b: Vector3) {
    const h = this.headPos(this.tmpHead);
    const da = this.tmpA.copy(a).sub(h).normalize();
    const db = this.tmpB.copy(b).sub(h).normalize();
    return da.angleTo(db);
  }

  /** Where a card at `pos` would land: 'done', 'part:index', or '' (back to rack). */
  private dropTarget(pos: Vector3): string {
    if (this.angleFromHead(pos, DONE_POS) < 0.26) return 'done';
    let best = '';
    let bestAng = 0.15;
    for (const part of PARTS) {
      for (let i = 0; i < SLOTS_PER_PART; i++) {
        this.slotPos(part, i, this.slotTmp);
        const ang = this.angleFromHead(pos, this.slotTmp);
        if (ang < bestAng) {
          bestAng = ang;
          best = `${part}:${i}`;
        }
      }
    }
    return best;
  }

  private onCardReleased(e: Entity) {
    const id = e.getValue(TaskCard, 'taskId') as string;
    const t = this.task(id);
    const o = e.object3D;
    this.setHighlight('');
    if (!t || !o) return;
    const target = this.dropTarget(o.getWorldPosition(this.dragPos));
    // A real drag cancels any tap-selection that the pinch started.
    if (this.dragPos.distanceTo(this.grabStart) > 0.03 && this.selectedId === t.id) this.selectedId = '';
    if (target === 'done') {
      this.completeTask(t);
      return;
    }
    if (target) {
      const [part, idxStr] = target.split(':') as [SlotPart, string];
      const index = Number(idxStr);
      const occupant = this.state.tasks.find(
        (x) => x.id !== t.id && x.place.kind === 'slot' && x.place.part === part && x.place.index === index,
      );
      if (occupant) occupant.place = t.place.kind === 'slot' ? { ...t.place } : { kind: 'inbox' };
      t.place = { kind: 'slot', part, index };
      this.removeGhost(t.id);
      this.blip(660, 0.06);
      if (occupant) this.drawTaskCard(occupant);
    } else if (t.place.kind === 'slot') {
      t.place = { kind: 'inbox' };
    }
    this.drawTaskCard(t);
    this.commit();
  }

  private setHighlight(h: string) {
    if (h === this.highlight) return;
    const doneChanged = (h === 'done') !== (this.highlight === 'done');
    this.highlight = h;
    this.drawBoard();
    if (doneChanged) this.drawDonePanel();
  }

  /** Tap-to-place: tap a card, then tap a slot or the Done zone. */
  private toggleSelect(id: string) {
    const e = this.cardEntities.get(id);
    // A pinch that moved the card is a drag, not a tap.
    if (e?.object3D && e.object3D.getWorldPosition(this.dragPos).distanceTo(this.grabStart) > 0.03 && this.grabStart.lengthSq() > 0) {
      this.grabStart.set(0, 0, 0);
      return;
    }
    const prev = this.selectedId;
    this.selectedId = prev === id ? '' : id;
    for (const tid of [prev, this.selectedId]) {
      const t = tid && this.task(tid);
      if (t) this.drawTaskCard(t);
    }
    if (this.selectedId) {
      const t = this.task(this.selectedId)!;
      this.agentStatus = `Picked “${t.title}”. Tap a slot on the board, or the Done zone.`;
      this.drawAgentPanel();
      this.blip(600, 0.04);
    }
    this.layoutAll();
  }

  private placeSelected(action: string) {
    const t = this.selectedId ? this.task(this.selectedId) : undefined;
    if (!t) return;
    this.selectedId = '';
    if (action === 'drop:done') {
      this.completeTask(t);
      return;
    }
    const [, part, idx] = action.split(':') as [string, SlotPart, string];
    const index = Number(idx);
    const occupant = this.state.tasks.find(
      (x) => x.id !== t.id && x.place.kind === 'slot' && x.place.part === part && x.place.index === index,
    );
    if (occupant) {
      occupant.place = t.place.kind === 'slot' ? { ...t.place } : { kind: 'inbox' };
      this.drawTaskCard(occupant);
    }
    t.place = { kind: 'slot', part, index };
    this.removeGhost(t.id);
    this.blip(660, 0.06);
    this.drawTaskCard(t);
    this.commit();
  }

  private completeTask(t: Task) {
    t.place = { kind: 'done' };
    markDone(this.state);
    const e = this.cardEntities.get(t.id);
    if (e) {
      this.targets.delete(e);
      e.dispose();
      this.cardEntities.delete(t.id);
      this.cardPlanes.delete(t.id);
    }
    this.removeGhost(t.id);
    this.chord();
    this.drawDonePanel();
    this.commit();
  }

  private commit() {
    saveState(this.state);
    this.layoutAll();
  }

  // ---------------------------------------------------------------- agent

  private onButton(action: string) {
    if (action.startsWith('slot:') || action === 'drop:done') {
      this.placeSelected(action);
      return;
    }
    this.blip(440, 0.05);
    if (action === 'plan') void this.runPlan();
    else if (action === 'accept') this.acceptAll();
    else if (action === 'dismiss') this.clearGhosts('Plan dismissed. Nothing was moved.');
    else if (action === 'reset') this.newDay();
    else if (action.startsWith('ctx:')) void this.dealCards(action.slice(4));
  }

  private async runPlan() {
    if (this.busy) return;
    const tasks = inboxTasks(this.state);
    if (!tasks.length) {
      this.agentStatus = 'Your rack is empty. Ask me for ideas below, or start a new day.';
      this.drawAgentPanel();
      return;
    }
    this.busy = true;
    this.clearGhosts('Thinking about your day…', false);
    const occupied = { morning: 0, afternoon: 0, evening: 0 } as Record<SlotPart, number>;
    for (const t of this.state.tasks) if (t.place.kind === 'slot') occupied[t.place.part]++;
    const result = await planDay(tasks, occupied);
    this.busy = false;
    this.agentSource = result.source;
    this.agentSummary = result.summary;
    this.showProposals(result.proposals);
  }

  private showProposals(proposals: Proposal[]) {
    const taken = new Set<string>();
    for (const t of this.state.tasks) if (t.place.kind === 'slot') taken.add(`${t.place.part}:${t.place.index}`);
    let placed = 0;
    for (const p of proposals) {
      let part = p.part;
      let index = -1;
      for (const candidate of [part, ...PARTS]) {
        for (let i = 0; i < SLOTS_PER_PART; i++) {
          if (!taken.has(`${candidate}:${i}`)) {
            index = i;
            part = candidate;
            break;
          }
        }
        if (index >= 0) break;
      }
      if (index < 0) continue;
      taken.add(`${part}:${index}`);
      const t = this.task(p.taskId);
      if (!t) continue;
      const plane = new CanvasPlane(1024, 256, CARD_W, CARD_H);
      plane.redraw((g, w, h) => drawCard(g, w, h, t.title, t.minutes, { ghost: true }));
      const card = this.cardEntities.get(t.id)?.object3D;
      if (card) plane.mesh.position.copy(card.position);
      plane.mesh.scale.setScalar(0.6);
      const entity = this.persistent(plane.mesh);
      entity.addComponent(GhostCard, { taskId: t.id });
      entity.addComponent(RayInteractable);
      entity.addComponent(PokeInteractable);
      this.slotPos(part, index, this.tmpA);
      this.tmpA.z += 0.02;
      this.setTarget(entity, this.tmpA, this.boardQuat, 1);
      this.ghosts.set(t.id, { entity, part, index, reason: p.reason });
      placed++;
    }
    this.agentStatus = placed
      ? `I propose ${placed} placement${placed > 1 ? 's' : ''}. Pinch a glowing card to accept it, or accept all.`
      : 'Your board is full. Finish or move something first.';
    this.drawAgentPanel();
    this.chime();
  }

  private acceptProposal(taskId: string) {
    const g = this.ghosts.get(taskId);
    const t = this.task(taskId);
    if (!g || !t) return;
    t.place = { kind: 'slot', part: g.part, index: g.index };
    this.removeGhost(taskId);
    this.drawTaskCard(t);
    this.blip(700, 0.06);
    this.agentStatus = this.ghosts.size
      ? `Accepted “${t.title}”. ${this.ghosts.size} proposal${this.ghosts.size > 1 ? 's' : ''} left.`
      : 'Plan accepted. Your day is set. Drag cards anytime to change it.';
    if (!this.ghosts.size) this.agentSummary = '';
    this.drawAgentPanel();
    this.commit();
  }

  private acceptAll() {
    if (!this.ghosts.size) return;
    for (const id of [...this.ghosts.keys()]) this.acceptProposal(id);
  }

  private removeGhost(taskId: string) {
    const g = this.ghosts.get(taskId);
    if (!g) return;
    this.targets.delete(g.entity);
    g.entity.dispose();
    this.ghosts.delete(taskId);
  }

  private clearGhosts(status: string, redraw = true) {
    for (const id of [...this.ghosts.keys()]) this.removeGhost(id);
    this.agentStatus = status;
    this.agentSummary = '';
    if (redraw) this.drawAgentPanel();
    else this.drawAgentPanel();
  }

  private async dealCards(context: string) {
    if (this.busy) return;
    this.busy = true;
    this.agentStatus = `Dealing ideas for “${context}”…`;
    this.drawAgentPanel();
    const r = await suggestTasks(context);
    this.busy = false;
    this.agentSource = r.source;
    const room = Math.max(0, 9 - inboxTasks(this.state).length);
    const fresh = r.tasks.slice(0, room);
    const origin = new Vector3().copy(AGENT_POS);
    for (const s of fresh) {
      const t: Task = { id: newId(), title: s.title, minutes: Math.max(5, Math.round(s.minutes || 15)), place: { kind: 'inbox' } };
      this.state.tasks.push(t);
      this.spawnCard(t, origin);
    }
    this.agentStatus = fresh.length
      ? `Dealt ${fresh.length} “${context}” card${fresh.length > 1 ? 's' : ''} to your rack. Keep the ones you like.`
      : 'Your rack is full. Place or finish a few cards first.';
    this.drawAgentPanel();
    this.chime();
    this.commit();
  }

  private newDay() {
    this.clearGhosts('New day. Pinch “Plan my day” when you are ready.');
    // Move unfinished board cards back to the rack, drop finished ones.
    this.state.tasks = this.state.tasks.filter((t) => t.place.kind !== 'done');
    for (const t of this.state.tasks) {
      t.place = { kind: 'inbox' };
      this.drawTaskCard(t);
    }
    this.state.doneToday = 0;
    this.drawDonePanel();
    this.commit();
  }

  // ---------------------------------------------------------------- sound

  private ctx(): AudioContext | null {
    try {
      this.audio ??= new AudioContext();
      return this.audio;
    } catch {
      return null;
    }
  }

  private blip(freq: number, dur: number) {
    const a = this.ctx();
    if (!a) return;
    const o = a.createOscillator();
    const g = a.createGain();
    o.frequency.value = freq;
    o.type = 'sine';
    g.gain.setValueAtTime(0.08, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur * 3);
    o.connect(g).connect(a.destination);
    o.start();
    o.stop(a.currentTime + dur * 3);
  }

  private chime() {
    [523, 659, 784].forEach((f, i) => setTimeout(() => this.blip(f, 0.08), i * 90));
  }

  private chord() {
    [659, 880, 1047].forEach((f, i) => setTimeout(() => this.blip(f, 0.1), i * 70));
  }
}
