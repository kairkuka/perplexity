import type { FormEvent } from "react";

interface CommandBarProps {
  command: string;
  onCommandChange: (value: string) => void;
  onRun: () => void;
  disabled: boolean;
}

export function CommandBar(props: CommandBarProps): JSX.Element {
  const { command, onCommandChange, onRun, disabled } = props;

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    onRun();
  };

  return (
    <form className="card command-bar" onSubmit={onSubmit}>
      <input
        aria-label="Command"
        className="command-input"
        value={command}
        onChange={(event) => {
          onCommandChange(event.target.value);
        }}
        placeholder="open https://example.com"
      />
      <button type="submit" disabled={disabled || command.trim().length === 0}>
        Run
      </button>
    </form>
  );
}
