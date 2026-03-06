interface ControlsProps {
  disabled: boolean;
  onResume: () => void;
  onStop: () => void;
}

export function Controls({ disabled, onResume, onStop }: ControlsProps): JSX.Element {
  return (
    <section className="card controls">
      <button onClick={onResume} disabled={disabled}>
        Resume
      </button>
      <button onClick={onStop} disabled={disabled}>
        Stop
      </button>
    </section>
  );
}
