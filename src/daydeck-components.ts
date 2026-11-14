import { createComponent, Types } from '@iwsdk/core';

/** A task card the user can pinch and drag. */
export const TaskCard = createComponent('TaskCard', {
  taskId: { type: Types.String, default: '' },
});

/** An agent-proposed placement the user can pinch to accept. */
export const GhostCard = createComponent('GhostCard', {
  taskId: { type: Types.String, default: '' },
});

/** A pressable button (pinch with a ray, or poke with a finger). */
export const DeckButton = createComponent('DeckButton', {
  action: { type: Types.String, default: '' },
});
