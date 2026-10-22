import { useState } from 'react';
import { Icon } from './Icon';

/** Copies `text` to the clipboard and says so for a moment. `label` omitted = an icon-only button. */
export function CopyButton({ text, label, testId, title = 'Copy' }: { text: string; label?: string; testId?: string; title?: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setDone(true);
    setTimeout(() => setDone(false), 1800);
  };
  return (
    <button
      className={`${label ? 'copy-btn' : 'copy-btn btn-icon ghost'}${done ? ' done' : ''}`}
      data-testid={testId}
      onClick={(e) => {
        e.stopPropagation();
        void copy();
      }}
      title={title}
      aria-label={label ? undefined : title}
    >
      <Icon name={done ? 'done' : 'copy'} size="xs" />
      {label && (done ? 'copied' : label)}
    </button>
  );
}
