import { Icon } from './Icon';

/** Which computer a session (or inbox item) runs on; nothing for this one. */
export function MachineChip({ machine, offline = false }: { machine?: string; offline?: boolean }) {
  if (!machine) return null;
  return (
    <span
      className={`machine-chip chip ${offline ? 'off' : ''}`}
      data-tone={offline ? undefined : 'peer'}
      data-testid="machine-chip"
      title={`Running on ${machine}${offline ? ' (offline)' : ''}`}
    >
      <Icon name="machine" size="xs" />
      {machine}
    </span>
  );
}

/** "This PC" / "This Mac" */
export function localMachineName(): string {
  return window.api.platform === 'darwin' ? 'This Mac' : 'This PC';
}
