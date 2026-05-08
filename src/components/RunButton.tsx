type State = "idle" | "running";

export function RunButton({
  state,
  onRun,
  onStop,
}: {
  state: State;
  onRun: () => void;
  onStop: () => void;
}) {
  if (state === "running") {
    return (
      <button
        onClick={onStop}
        className="px-4 py-1.5 rounded text-sm font-semibold bg-[var(--color-danger)] text-black hover:opacity-90 transition-opacity flex items-center gap-1.5"
      >
        <span className="inline-block w-2 h-2 bg-black rounded-sm" />
        Stop
      </button>
    );
  }
  return (
    <button
      onClick={onRun}
      className="px-4 py-1.5 rounded text-sm font-semibold bg-[var(--color-accent)] text-black hover:bg-[var(--color-accent-hover)] transition-colors flex items-center gap-1.5"
    >
      <span>▶</span>
      Run
    </button>
  );
}
