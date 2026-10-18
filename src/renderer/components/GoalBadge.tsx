import { GOAL_INFO, type GoalResult } from '@core/goal';
import { Icon } from './Icon';

/** icon + word, coloured per goal; the tooltip carries the "because" */
export function GoalBadge({ goal, glyphOnly = false }: { goal: GoalResult; glyphOnly?: boolean }) {
  const info = GOAL_INFO[goal.goal];
  return (
    <span className={`goal g-${goal.goal} c-${goal.confidence}`} title={`${info.title} (${goal.confidence} confidence)\n${goal.because}`} data-goal={goal.goal}>
      <Icon name={goal.goal} size="xs" />
      {!glyphOnly && info.word}
    </span>
  );
}
