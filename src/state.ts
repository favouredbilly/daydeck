// DayDeck data model: tasks, where they live, and persistence between visits.

export type SlotPart = 'morning' | 'afternoon' | 'evening';
export const PARTS: SlotPart[] = ['morning', 'afternoon', 'evening'];
export const PART_LABEL: Record<SlotPart, string> = {
  morning: 'MORNING',
  afternoon: 'AFTERNOON',
  evening: 'EVENING',
};
export const SLOTS_PER_PART = 4;

export interface Task {
  id: string;
  title: string;
  minutes: number;
  /** Where the card is: in the desk inbox, on a board slot, or done. */
  place: { kind: 'inbox' } | { kind: 'slot'; part: SlotPart; index: number } | { kind: 'done' };
}

export interface DeckState {
  tasks: Task[];
  doneToday: number;
  streakDays: number;
  lastDoneDate: string | null;
}

const KEY = 'daydeck.v1';

let counter = 0;
export const newId = () => `t${Date.now().toString(36)}${(counter++).toString(36)}`;

export const STARTER_TASKS: Array<[string, number]> = [
  ['Write project proposal', 90],
  ['Reply to emails', 30],
  ['30-min walk', 30],
  ['Grocery list', 10],
  ['Call mom', 20],
  ['Read 20 pages', 25],
];

export function freshState(): DeckState {
  return {
    tasks: STARTER_TASKS.map(([title, minutes]) => ({
      id: newId(),
      title,
      minutes,
      place: { kind: 'inbox' as const },
    })),
    doneToday: 0,
    streakDays: 0,
    lastDoneDate: null,
  };
}

export function loadState(): DeckState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as DeckState;
      if (Array.isArray(s.tasks)) {
        const today = new Date().toDateString();
        if (s.lastDoneDate !== today) s.doneToday = 0;
        return s;
      }
    }
  } catch {
    /* storage unavailable: start fresh */
  }
  return freshState();
}

export function saveState(s: DeckState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export function markDone(s: DeckState): void {
  const today = new Date().toDateString();
  if (s.lastDoneDate !== today) {
    const y = new Date(Date.now() - 86400000).toDateString();
    s.streakDays = s.lastDoneDate === y ? s.streakDays + 1 : 1;
    s.lastDoneDate = today;
    s.doneToday = 0;
  }
  s.doneToday += 1;
}

export function slotOccupant(s: DeckState, part: SlotPart, index: number): Task | undefined {
  return s.tasks.find(
    (t) => t.place.kind === 'slot' && t.place.part === part && t.place.index === index,
  );
}

export function firstFreeSlot(s: DeckState, part: SlotPart): number {
  for (let i = 0; i < SLOTS_PER_PART; i++) if (!slotOccupant(s, part, i)) return i;
  return -1;
}

export function inboxTasks(s: DeckState): Task[] {
  return s.tasks.filter((t) => t.place.kind === 'inbox');
}
