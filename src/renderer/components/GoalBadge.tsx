import { GOAL_INFO, type GoalResult } from '@core/goal';

/** glyph + word, coloured per goal; the tooltip carries the "because" */
export function GoalBadge({ goal, glyphOnly = false }: { goal: GoalResult; glyphOnly?: boolean }) {
  const info = GOAL_INFO[goal.goal];
  return (
    <span className={`goal g-${goal.goal} c-${goal.confidence}`} title={`${info.title} (${goal.confidence} confidence)\n${goal.because}`} data-goal={goal.goal}>
      {info.glyph}
      {!glyphOnly && ` ${info.word}`}
    </span>
  );
}
