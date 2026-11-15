// DayDeck: a seated, hands-first planning space with an AI agent.
//
// Layout (meters, player origin at the floor, seated head about 1.2 m):
//   - desk + card rack in front of you (within arm's reach)
//   - the day board straight ahead (Morning / Afternoon / Evening)
//   - the agent panel on one side, the Done panel on the other (swappable)
//   - a guide banner above the board for the first five minutes

import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  createSystem,
  DistanceGrabbable,
  Entity,
  Grabbed,
  Group,
  Hovered,
  IcosahedronGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  MovementMode,
  Object3D,
  PlaneGeometry,
  PointLight,
  PokeInteractable,
  Pressed,
  Quaternion,
  RayInteractable,
  SphereGeometry,
  Vector3,
} from '@iwsdk/core';
import { planDay, reviewDay, suggestTasks, type Proposal } from './agent.js';
import { DeckButton, GhostCard, TaskCard } from './daydeck-components.js';
import { C, CanvasPlane, drawButton, drawCard, FONT, roundRect, setTextScale, ts, wrapText } from './draw.js';
import {
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
const LEFT_POS = new Vector3(-0.8, 1.2, -0.5);
const RIGHT_POS = new Vector3(0.8, 1.2, -0.5);
const HEAD_FALLBACK = new Vector3(0, 1.2, 0);

type BtnStyle = 'primary' | 'secondary' | 'chip' | 'toggle-on';
type Btn = { plane: CanvasPlane; entity: Entity; label: string; style: BtnStyle; hover: boolean };
type Ghost = { entity: Entity; part: SlotPart; index: number; reason: string };

const TUTORIAL_STEPS = 4;

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
  private ghosts = new Map<string, Ghost>();
  private targets = new Map<Entity, { pos: Vector3; quat: Quaternion; scale: number }>();
  private buttons = new Map<string, Btn>();
  private agentPanel!: CanvasPlane;
  private donePanel!: CanvasPlane;
  private board!: CanvasPlane;
  private guideGroup!: Object3D;
  private arrow!: Mesh;
  private agentGroup!: Object3D;
  private doneGroup!: Object3D;
  private agentPos = LEFT_POS.clone();
  private donePos = RIGHT_POS.clone();
  private agentStatus = 'Hi! I am your planning agent. I propose, you decide: nothing moves without your pinch.';
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
  private arrowTarget = new Vector3();
  private arrowVisible = false;
  private time = 0;

  init(): void {
    this.state = loadState();
    (window as any).__deck = this;
    setTextScale(this.state.settings.largeText ? 1.2 : 1);
    if (this.state.settings.swapSides) {
      this.agentPos.copy(RIGHT_POS);
      this.donePos.copy(LEFT_POS);
    }
    this.welcomeBack();
    this.buildEnvironment();
    this.buildBoard();
    this.buildAgentPanel();
    this.buildDonePanel();
    this.buildGuide();
    for (const t of this.state.tasks) if (t.place.kind !== 'done') this.spawnCard(t);
    this.layoutAll(true);
    this.refreshGuide();
    // Fonts load asynchronously; repaint once they are ready.
    document.fonts?.ready.then(() => this.redrawEverything());

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
    this.time += delta;
    const calm = this.state.settings.calmMotion;
    let dragging = false;
    for (const e of this.queries.grabbedCards.entities) {
      const o = e.object3D;
      if (!o) continue;
      dragging = true;
      this.setHighlight(this.dropTarget(o.getWorldPosition(this.dragPos)));
      break;
    }
    if (!dragging && this.highlight) this.setHighlight('');

    const k = calm ? 1 : 1 - Math.exp(-delta * 12);
    for (const [entity, t] of this.targets) {
      const o = entity.object3D;
      if (!o || entity.hasComponent(Grabbed)) continue;
      o.position.lerp(t.pos, k);
      o.quaternion.slerp(t.quat, k);
      const s = o.scale.x + (t.scale - o.scale.x) * k;
      o.scale.setScalar(s);
    }
    // Gentle breathing on agent proposals so they read as "pending".
    if (!calm) {
      const pulse = 1 + 0.03 * Math.sin(this.time * 4);
      for (const g of this.ghosts.values()) {
        const o = g.entity.object3D;
        const t = this.targets.get(g.entity);
        if (o && t && Math.abs(o.scale.x - t.scale) < 0.05) o.scale.setScalar(pulse);
      }
    }
    // Tutorial pointer
    if (this.arrowVisible) {
      this.arrow.position.copy(this.arrowTarget);
      this.arrow.position.y += 0.085 + (calm ? 0 : 0.02 * Math.sin(this.time * 5));
    }
  }

  // ---------------------------------------------------------------- building

  private persistent(obj: Object3D, parent?: Entity): Entity {
    return this.world.createTransformEntity(obj, parent ? { parent, persistent: true } : { persistent: true });
  }

  private buildEnvironment() {
    const wood = new MeshStandardMaterial({ color: 0xc79a6e, roughness: 0.55 });
    const dark = new MeshStandardMaterial({ color: 0x3d3446, roughness: 0.5 });
    const desk = new Mesh(new BoxGeometry(1.4, 0.04, 0.5), wood);
    desk.position.set(0, 0.72, -0.48);
    desk.castShadow = desk.receiveShadow = true;
    this.persistent(desk);
    for (const [x, z] of [[-0.66, -0.26], [0.66, -0.26], [-0.66, -0.7], [0.66, -0.7]]) {
      const leg = new Mesh(new CylinderGeometry(0.018, 0.018, 0.7), dark);
      leg.position.set(x, 0.35, z);
      this.persistent(leg);
    }
    for (let r = 0; r < 3; r++) {
      const step = new Mesh(new BoxGeometry(1.2, 0.02, 0.08), dark);
      step.position.set(0, 0.745 + r * 0.07, -0.32 - r * 0.1);
      this.persistent(step);
    }
    // Cozy touches: a rug, a plant, a mug and a warm lamp glow.
    const rug = new Mesh(new CylinderGeometry(1.15, 1.15, 0.01, 48), new MeshStandardMaterial({ color: 0xd99b7c, roughness: 0.95 }));
    rug.position.set(0, 0.005, -0.35);
    rug.receiveShadow = true;
    this.persistent(rug);

    const plant = new Group();
    const pot = new Mesh(new CylinderGeometry(0.11, 0.085, 0.22, 24), new MeshStandardMaterial({ color: 0xe9e2d6, roughness: 0.7 }));
    pot.position.y = 0.11;
    plant.add(pot);
    const leafMat = new MeshStandardMaterial({ color: 0x5f8f5a, roughness: 0.8, flatShading: true });
    const blobs: Array<[number, number, number, number]> = [
      [0, 0.36, 0, 0.13], [0.07, 0.47, 0.03, 0.1], [-0.07, 0.45, -0.02, 0.1], [0.02, 0.56, -0.03, 0.08],
    ];
    for (const [x, y, z, r] of blobs) {
      const leaf = new Mesh(new IcosahedronGeometry(r, 1), leafMat);
      leaf.position.set(x, y, z);
      leaf.castShadow = true;
      plant.add(leaf);
    }
    plant.position.set(-1.0, 0, -0.05);
    this.persistent(plant);

    const mug = new Group();
    const cup = new Mesh(new CylinderGeometry(0.035, 0.032, 0.085, 24), new MeshStandardMaterial({ color: 0x5b4bdb, roughness: 0.4 }));
    cup.position.y = 0.0425;
    mug.add(cup);
    const coffee = new Mesh(new CylinderGeometry(0.031, 0.031, 0.004, 24), new MeshStandardMaterial({ color: 0x4a2c1d, roughness: 0.3 }));
    coffee.position.y = 0.08;
    mug.add(coffee);
    mug.position.set(0.58, 0.74, -0.26);
    this.persistent(mug);

    const lamp = new PointLight(0xffc98a, 2.2, 3.5, 2);
    lamp.position.set(0, 1.9, -0.3);
    this.persistent(lamp);
    const bulb = new Mesh(new SphereGeometry(0.012, 12, 12), new MeshBasicMaterial({ color: 0xffd9a8 }));
    bulb.position.copy(lamp.position);
    this.persistent(bulb);
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

  private boardTitle() {
    return this.state.reviewedOn === new Date().toDateString() ? 'Tomorrow' : 'Today';
  }

  private drawBoard() {
    const title = this.boardTitle();
    this.board.redraw((g, w, h) => {
      roundRect(g, 4, 4, w - 8, h - 8, 36);
      g.fillStyle = 'rgba(255,253,249,0.97)';
      g.fill();
      g.font = `800 46px ${FONT}`;
      g.textBaseline = 'middle';
      g.fillStyle = C.ink;
      g.fillText(title, 48, 56);
      const tw = g.measureText(title).width;
      const step = this.state.tutorialStep;
      if (step < 5) {
        // Guided tour lives in the board header, always in view.
        const x0 = 48 + tw + 28;
        const pw = w - x0 - (step < TUTORIAL_STEPS ? 250 : 40);
        roundRect(g, x0, 14, pw, 84, 42);
        g.fillStyle = C.accent;
        g.fill();
        g.fillStyle = 'rgba(255,255,255,0.8)';
        g.font = `800 28px ${FONT}`;
        const tag = step < TUTORIAL_STEPS ? `${step + 1}/${TUTORIAL_STEPS}` : '✓';
        g.fillText(tag, x0 + 30, 57);
        g.fillStyle = '#fff';
        g.font = `700 ${ts(29)}px ${FONT}`;
        const lines = wrapText(g, this.guideText(), pw - 140, 2);
        const lh = ts(33);
        lines.forEach((l, i) => g.fillText(l, x0 + 110, 57 - ((lines.length - 1) * lh) / 2 + i * lh));
      } else {
        g.font = `500 ${ts(30)}px ${FONT}`;
        g.fillStyle = C.muted;
        g.fillText('Pinch a card and drag it onto your day', 48 + tw + 30, 58);
      }
      const colW = w / 3;
      PARTS.forEach((p, i) => {
        const cx = colW * i + colW / 2;
        g.fillStyle = C.part[p];
        g.font = `800 ${ts(34)}px ${FONT}`;
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
            g.strokeStyle = '#d6cfc4';
            g.stroke();
            g.setLineDash([]);
          }
        }
      });
    });
  }

  private buildAgentPanel() {
    this.agentGroup = new Group();
    const parent = this.persistent(this.agentGroup);
    this.placeSidePanel(this.agentGroup, this.agentPos);
    this.agentPanel = new CanvasPlane(1024, 1180, 0.6, 0.69);
    this.persistent(this.agentPanel.mesh, parent);
    this.makeButton('plan', 'Plan my day', 'primary', 0.5, 0.07, 0, -0.105, parent);
    this.makeButton('accept', 'Accept all', 'secondary', 0.24, 0.06, -0.13, -0.19, parent);
    this.makeButton('dismiss', 'Dismiss', 'secondary', 0.24, 0.06, 0.13, -0.19, parent);
    this.makeButton('ctx:Morning routine', 'Morning routine', 'chip', 0.18, 0.05, -0.19, -0.285, parent);
    this.makeButton('ctx:Deep work', 'Deep work', 'chip', 0.18, 0.05, 0, -0.285, parent);
    this.makeButton('ctx:Wind-down', 'Wind-down', 'chip', 0.18, 0.05, 0.19, -0.285, parent);
    this.drawAgentPanel();
  }

  private placeSidePanel(group: Object3D, pos: Vector3) {
    group.position.copy(pos);
    group.rotation.set(0, facingYaw(pos), 0);
  }

  private drawAgentPanel() {
    const proposals = [...this.ghosts.entries()];
    this.agentPanel.redraw((g, w, h) => {
      roundRect(g, 4, 4, w - 8, h - 8, 40);
      g.fillStyle = C.panel;
      g.fill();
      g.textBaseline = 'middle';
      g.fillStyle = C.accent;
      g.font = `800 48px ${FONT}`;
      g.fillText('✦ Planning agent', 48, 70);
      // who is thinking: a clear badge
      if (this.agentSource) {
        const label = this.agentSource === 'ai' ? '✦ Claude' : 'Offline planner';
        g.font = `700 28px ${FONT}`;
        const bw = g.measureText(label).width + 36;
        roundRect(g, w - 44 - bw, 46, bw, 50, 25);
        g.fillStyle = this.agentSource === 'ai' ? C.accent : '#ece9f2';
        g.fill();
        g.fillStyle = this.agentSource === 'ai' ? '#fff' : C.muted;
        g.fillText(label, w - 44 - bw + 18, 72);
      }
      g.font = `600 ${ts(36)}px ${FONT}`;
      g.fillStyle = C.ink;
      let y = 150;
      for (const line of wrapText(g, this.agentStatus, w - 96, 3)) {
        g.fillText(line, 48, y);
        y += ts(46);
      }
      if (this.agentSummary) {
        y += 6;
        g.font = `italic 500 ${ts(31)}px ${FONT}`;
        g.fillStyle = C.muted;
        for (const line of wrapText(g, this.agentSummary, w - 96, 2)) {
          g.fillText(line, 48, y);
          y += ts(40);
        }
      }
      y += 14;
      for (const [taskId, p] of proposals.slice(0, 6)) {
        const t = this.task(taskId);
        if (!t) continue;
        if (y > 690) break;
        g.fillStyle = C.part[p.part];
        g.beginPath();
        g.arc(60, y, 11, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = C.ink;
        g.font = `700 ${ts(31)}px ${FONT}`;
        const head = `${t.title} → ${PART_LABEL[p.part].toLowerCase()}`;
        g.fillText(wrapText(g, head, w - 130, 1)[0], 84, y);
        y += ts(37);
        g.font = `500 ${ts(27)}px ${FONT}`;
        g.fillStyle = C.muted;
        g.fillText(wrapText(g, p.reason, w - 130, 1)[0], 84, y);
        y += ts(48);
      }
      g.fillStyle = '#e6e2ee';
      g.fillRect(48, h * 0.62, w - 96, 3);
      g.font = `600 30px ${FONT}`;
      g.fillStyle = C.muted;
      g.fillText('Need ideas? I can deal you cards:', 48, h * 0.86);
    });
  }

  private buildDonePanel() {
    this.doneGroup = new Group();
    const parent = this.persistent(this.doneGroup);
    this.placeSidePanel(this.doneGroup, this.donePos);
    this.donePanel = new CanvasPlane(1024, 1180, 0.6, 0.69);
    this.persistent(this.donePanel.mesh, parent);
    const zone = new Mesh(new PlaneGeometry(0.53, 0.18), new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
    zone.position.set(0, 0.2, 0.01);
    const ze = this.persistent(zone, parent);
    ze.addComponent(DeckButton, { action: 'drop:done' });
    ze.addComponent(RayInteractable);
    this.makeButton('review', 'Review my day', 'primary', 0.5, 0.065, 0, -0.17, parent);
    const st = this.state.settings;
    this.makeButton('set:largeText', 'Aa Larger text', st.largeText ? 'toggle-on' : 'chip', 0.18, 0.05, -0.19, -0.285, parent);
    this.makeButton('set:swapSides', '⇄ Swap sides', st.swapSides ? 'toggle-on' : 'chip', 0.18, 0.05, 0, -0.285, parent);
    this.makeButton('set:calmMotion', 'Calm motion', st.calmMotion ? 'toggle-on' : 'chip', 0.18, 0.05, 0.19, -0.285, parent);
    this.drawDonePanel();
  }

  private drawDonePanel() {
    const s = this.state;
    const done = s.tasks.filter((t) => t.place.kind === 'done').slice(-3).reverse();
    this.donePanel.redraw((g, w, h) => {
      roundRect(g, 4, 4, w - 8, h - 8, 40);
      g.fillStyle = 'rgba(255,253,249,0.97)';
      g.fill();
      g.textBaseline = 'middle';
      g.fillStyle = C.green;
      g.font = `800 48px ${FONT}`;
      g.fillText('✓ Done', 48, 70);
      roundRect(g, 48, 120, w - 96, 280, 32);
      g.fillStyle = this.highlight === 'done' ? '#bfead4' : '#e8f6ef';
      g.fill();
      g.setLineDash([16, 12]);
      g.lineWidth = 5;
      g.strokeStyle = C.green;
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = C.green;
      g.font = `700 ${ts(36)}px ${FONT}`;
      g.textAlign = 'center';
      g.fillText('Drop a finished card here', w / 2, 260);
      g.textAlign = 'left';
      g.fillStyle = C.ink;
      g.font = `800 84px ${FONT}`;
      g.fillText(String(s.doneToday), 60, 480);
      g.font = `600 ${ts(30)}px ${FONT}`;
      g.fillStyle = C.muted;
      g.fillText('done today', 170, 488);
      g.fillStyle = C.ink;
      g.font = `800 84px ${FONT}`;
      g.fillText(String(s.streakDays), 540, 480);
      g.font = `600 ${ts(30)}px ${FONT}`;
      g.fillStyle = C.muted;
      g.fillText(s.streakDays === 1 ? 'day streak' : 'days streak', 640, 488);
      let y = 580;
      g.font = `500 ${ts(32)}px ${FONT}`;
      for (const t of done) {
        g.fillStyle = C.green;
        g.fillText('✓', 60, y);
        g.fillStyle = C.muted;
        g.fillText(wrapText(g, t.title, w - 160, 1)[0], 104, y);
        y += ts(48);
      }
      g.fillStyle = '#e6e2ee';
      g.fillRect(48, h * 0.83, w - 96, 3);
      g.font = `600 26px ${FONT}`;
      g.fillStyle = C.muted;
      g.fillText('Comfort settings', 48, h * 0.865);
    });
  }

  private buildGuide() {
    const holder = new Group();
    holder.position.set(0.6, 1.3 + 0.365 - 0.054, BOARD_Z + 0.004);
    this.guideGroup = holder;
    const parent = this.persistent(holder);
    this.makeButton('guide:skip', 'Skip tour', 'secondary', 0.14, 0.05, 0, 0, parent);
    this.buttons.get('guide:skip')!.plane.mesh.position.z = 0.002;
    this.arrow = new Mesh(new ConeGeometry(0.022, 0.05, 20), new MeshBasicMaterial({ color: 0x5b4bdb }));
    this.arrow.rotation.x = Math.PI; // point down
    this.arrow.visible = false;
    this.persistent(this.arrow);
  }

  private guideText(): string {
    const agentSide = this.state.settings.swapSides ? 'right' : 'left';
    const doneSide = this.state.settings.swapSides ? 'left' : 'right';
    switch (this.state.tutorialStep) {
      case 0:
        return 'Pinch a card on your desk and drag it onto MORNING (or pinch it, then pinch a slot).';
      case 1:
        return `Now pinch ✦ Plan my day on your ${agentSide}. The AI agent will propose a plan.`;
      case 2:
        return 'Pinch a glowing ✦ card to accept it. You approve every move.';
      case 3:
        return `Finished something? Drag a card onto Done on your ${doneSide}.`;
      default:
        return 'You are set! Your board is saved. Tonight, pinch Review my day to close out.';
    }
  }

  private refreshGuide() {
    this.guideGroup.visible = this.state.tutorialStep < TUTORIAL_STEPS;
    this.drawBoard();
    this.updateArrow();
  }

  private updateArrow() {
    const step = this.state.tutorialStep;
    let target: Vector3 | null = null;
    if (step === 0) {
      const first = inboxTasks(this.state)[0];
      const e = first && this.cardEntities.get(first.id);
      if (e) {
        this.rackPos(0, this.arrowTarget);
        target = this.arrowTarget;
      }
    } else if (step === 1) {
      const b = this.buttons.get('plan');
      if (b) target = b.plane.mesh.getWorldPosition(this.arrowTarget);
    } else if (step === 2) {
      const g = this.ghosts.values().next().value as Ghost | undefined;
      if (g) {
        this.slotPos(g.part, g.index, this.arrowTarget);
        target = this.arrowTarget;
      }
    } else if (step === 3) {
      this.arrowTarget.copy(this.donePos);
      this.arrowTarget.y += 0.2;
      target = this.arrowTarget;
    }
    this.arrowVisible = !!target;
    this.arrow.visible = this.arrowVisible;
  }

  /** Advance the tour when the user completes the step it asked for. */
  private tutorial(completed: number) {
    if (this.state.tutorialStep !== completed) return;
    this.state.tutorialStep = completed + 1;
    if (this.state.tutorialStep === TUTORIAL_STEPS) {
      this.chime();
      setTimeout(() => {
        if (this.state.tutorialStep === TUTORIAL_STEPS) {
          this.state.tutorialStep = 5;
          saveState(this.state);
          this.refreshGuide();
        }
      }, 7000);
    }
    saveState(this.state);
    this.refreshGuide();
  }

  private welcomeBack() {
    const today = new Date().toDateString();
    const s = this.state;
    if (s.lastVisit && s.lastVisit !== today && s.tutorialStep >= 5) {
      const onBoard = s.tasks.filter((t) => t.place.kind === 'slot').length;
      this.agentStatus =
        s.streakDays > 0
          ? `Welcome back! You are on a ${s.streakDays}-day streak. ${onBoard ? `${onBoard} cards are waiting on your board.` : 'Want me to plan today?'}`
          : `Welcome back! ${onBoard ? `${onBoard} cards are waiting on your board.` : 'Want me to plan today?'}`;
    }
    s.lastVisit = today;
    saveState(s);
  }

  private makeButton(action: string, label: string, style: BtnStyle, w: number, h: number, x: number, y: number, parent: Entity) {
    const plane = new CanvasPlane(Math.round(w * 1400), Math.round(h * 1400), w, h);
    plane.mesh.position.set(x, y, 0.012);
    const entity = this.persistent(plane.mesh, parent);
    entity.addComponent(DeckButton, { action });
    entity.addComponent(RayInteractable);
    entity.addComponent(PokeInteractable);
    const btn: Btn = { plane, entity, label, style, hover: false };
    this.buttons.set(action, btn);
    this.drawBtn(btn);
  }

  private drawBtn(btn: Btn) {
    btn.plane.redraw((g, pw, ph) => drawButton(g, pw, ph, btn.label, btn.style, btn.hover));
  }

  private setHover(e: Entity, hover: boolean) {
    const btn = this.buttons.get(e.getValue(DeckButton, 'action') as string);
    if (!btn) return;
    btn.hover = hover;
    this.drawBtn(btn);
  }

  private redrawEverything() {
    this.drawBoard();
    this.drawAgentPanel();
    this.drawDonePanel();
    this.refreshGuide();
    for (const t of this.state.tasks) this.drawTaskCard(t);
    for (const b of this.buttons.values()) this.drawBtn(b);
  }

  // ---------------------------------------------------------------- cards

  private task(id: string): Task | undefined {
    return this.state.tasks.find((t) => t.id === id);
  }

  private spawnCard(t: Task, from?: Vector3) {
    const plane = new CanvasPlane(1024, 256, CARD_W, CARD_H);
    this.cardPlanes.set(t.id, plane);
    this.drawTaskCard(t);
    if (from) {
      plane.mesh.position.copy(from);
      plane.mesh.scale.setScalar(0.3);
    }
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
        e.object3D?.scale.setScalar(t.scale);
      }
    }
    if (this.state.tutorialStep === 0) this.updateArrow();
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
    if (this.angleFromHead(pos, this.donePos) < 0.26) return 'done';
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
    if (this.dragPos.distanceTo(this.grabStart) > 0.03 && this.selectedId === t.id) {
      this.selectedId = '';
      if (this.agentStatus.startsWith('Picked')) {
        this.agentStatus = 'Nice move. Pinch “Plan my day” whenever you want my suggestions.';
        this.drawAgentPanel();
      }
    }
    if (target === 'done') {
      this.completeTask(t);
      return;
    }
    if (target) {
      const [part, idxStr] = target.split(':') as [SlotPart, string];
      this.placeTask(t, part, Number(idxStr));
      return;
    }
    if (t.place.kind === 'slot') t.place = { kind: 'inbox' };
    this.drawTaskCard(t);
    this.commit();
  }

  private placeTask(t: Task, part: SlotPart, index: number) {
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
    this.tutorial(0);
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
    if (e?.object3D && this.grabStart.lengthSq() > 0 && e.object3D.getWorldPosition(this.dragPos).distanceTo(this.grabStart) > 0.03) {
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
      this.agentStatus = `Picked “${t.title}”. Now pinch a slot on the board, or the Done zone.`;
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
    this.placeTask(t, part, Number(idx));
  }

  private completeTask(t: Task) {
    t.place = { kind: 'done' };
    markDone(this.state);
    const e = this.cardEntities.get(t.id);
    if (e) {
      this.cardEntities.delete(t.id);
      this.cardPlanes.delete(t.id);
      // Fly into the Done zone, shrink, then remove.
      this.tmpA.copy(this.donePos);
      this.tmpA.y += 0.2;
      const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), facingYaw(this.donePos));
      this.setTarget(e, this.tmpA, q, 0.15);
      setTimeout(() => {
        this.targets.delete(e);
        e.dispose();
      }, this.state.settings.calmMotion ? 0 : 450);
    }
    this.removeGhost(t.id);
    this.chord();
    this.drawDonePanel();
    this.commit();
    this.tutorial(3);
  }

  private commit() {
    saveState(this.state);
    this.layoutAll();
  }

  // ---------------------------------------------------------------- buttons

  private onButton(action: string) {
    if (action.startsWith('slot:') || action === 'drop:done') {
      this.placeSelected(action);
      return;
    }
    this.blip(440, 0.05);
    if (action === 'plan') void this.runPlan();
    else if (action === 'accept') this.acceptAll();
    else if (action === 'dismiss') this.clearGhosts('Plan dismissed. Nothing was moved.');
    else if (action === 'review') void this.runReview();
    else if (action === 'guide:skip') {
      this.state.tutorialStep = 5;
      saveState(this.state);
      this.refreshGuide();
    } else if (action.startsWith('set:')) this.toggleSetting(action.slice(4) as keyof DeckState['settings']);
    else if (action.startsWith('ctx:')) void this.dealCards(action.slice(4));
  }

  private toggleSetting(key: keyof DeckState['settings']) {
    const st = this.state.settings;
    st[key] = !st[key];
    const btn = this.buttons.get(`set:${key}`);
    if (btn) {
      btn.style = st[key] ? 'toggle-on' : 'chip';
      this.drawBtn(btn);
    }
    if (key === 'largeText') {
      setTextScale(st.largeText ? 1.2 : 1);
      this.redrawEverything();
    } else if (key === 'swapSides') {
      this.agentPos.copy(st.swapSides ? RIGHT_POS : LEFT_POS);
      this.donePos.copy(st.swapSides ? LEFT_POS : RIGHT_POS);
      this.placeSidePanel(this.agentGroup, this.agentPos);
      this.placeSidePanel(this.doneGroup, this.donePos);
      this.refreshGuide();
    }
    saveState(this.state);
  }

  // ---------------------------------------------------------------- agent

  private async runPlan() {
    if (this.busy) return;
    const tasks = inboxTasks(this.state);
    if (!tasks.length) {
      this.agentStatus = 'Your rack is empty. Ask me for ideas below, or review your day.';
      this.drawAgentPanel();
      return;
    }
    this.busy = true;
    this.clearGhosts('Thinking about your day…');
    const occupied = { morning: 0, afternoon: 0, evening: 0 } as Record<SlotPart, number>;
    for (const t of this.state.tasks) if (t.place.kind === 'slot') occupied[t.place.part]++;
    const result = await planDay(tasks, occupied);
    this.busy = false;
    this.agentSource = result.source;
    this.agentSummary = result.summary;
    this.showProposals(result.proposals);
  }

  private async runReview() {
    if (this.busy) return;
    this.busy = true;
    this.clearGhosts('Reviewing your day…');
    const done = this.state.tasks.filter((t) => t.place.kind === 'done').map((t) => t.title);
    const unfinished = this.state.tasks.filter((t) => t.place.kind !== 'done');
    const r = await reviewDay(done, unfinished, this.state.streakDays);
    this.busy = false;
    this.agentSource = r.source;
    // Close today: finished cards are archived, unfinished ones return to the rack.
    this.state.tasks = unfinished;
    for (const t of unfinished) {
      t.place = { kind: 'inbox' };
      this.drawTaskCard(t);
    }
    this.state.doneToday = 0;
    this.state.reviewedOn = new Date().toDateString();
    this.drawBoard();
    this.drawDonePanel();
    this.commit();
    this.agentSummary = r.summary;
    this.showProposals(r.proposals, r.recap);
  }

  private showProposals(proposals: Proposal[], intro?: string) {
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
      const t = this.task(p.taskId);
      if (!t || t.place.kind !== 'inbox' || this.ghosts.has(t.id)) continue;
      taken.add(`${part}:${index}`);
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
    const ask = placed
      ? `I propose ${placed} placement${placed > 1 ? 's' : ''}. Pinch a glowing card to accept it, or accept all.`
      : 'Your board is full. Finish or move something first.';
    this.agentStatus = intro ? `${intro} ${placed ? 'Pinch a glowing card to keep it for tomorrow.' : ''}`.trim() : ask;
    this.drawAgentPanel();
    this.chime();
    if (placed) this.tutorial(1);
    else this.updateArrow();
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
    this.tutorial(2);
    this.updateArrow();
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

  private clearGhosts(status: string) {
    for (const id of [...this.ghosts.keys()]) this.removeGhost(id);
    this.agentStatus = status;
    this.agentSummary = '';
    this.drawAgentPanel();
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
    const origin = this.agentPos.clone();
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
    o.type = 'triangle';
    g.gain.setValueAtTime(0.0001, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.06, a.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur * 3);
    o.connect(g).connect(a.destination);
    o.start();
    o.stop(a.currentTime + dur * 3 + 0.02);
  }

  private chime() {
    [523, 659, 784].forEach((f, i) => setTimeout(() => this.blip(f, 0.08), i * 90));
  }

  private chord() {
    [659, 880, 1047].forEach((f, i) => setTimeout(() => this.blip(f, 0.1), i * 70));
  }
}
