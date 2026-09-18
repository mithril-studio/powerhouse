import type {
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionModeState,
} from "@agentclientprotocol/sdk";

interface Props {
  modes: SessionModeState | null;
  configOptions: SessionConfigOption[];
  disabled: boolean;
  onModeChange: (modeId: string) => void;
  onConfigChange: (configId: string, value: string | boolean) => void;
}

const selectClass =
  "h-7 max-w-40 rounded-md border border-border bg-background px-2 text-xs text-foreground disabled:opacity-50";

function isGroup(value: object): value is SessionConfigSelectGroup {
  return "group" in value;
}

export function AcpSessionControls({
  modes,
  configOptions,
  disabled,
  onModeChange,
  onConfigChange,
}: Props) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      {modes && modes.availableModes.length > 1 && (
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="sr-only">Agent mode</span>
          <select
            title="Agent mode"
            value={modes.currentModeId}
            disabled={disabled}
            onChange={(event) => onModeChange(event.target.value)}
            className={selectClass}
          >
            {modes.availableModes.map((mode) => (
              <option key={mode.id} value={mode.id}>
                {mode.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {configOptions.map((option) =>
        option.type === "boolean" ? (
          <label
            key={option.id}
            title={option.description ?? option.name}
            className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
          >
            <input
              type="checkbox"
              checked={option.currentValue}
              disabled={disabled}
              onChange={(event) => onConfigChange(option.id, event.target.checked)}
              className="accent-accent-brand"
            />
            {option.name}
          </label>
        ) : (
          <label key={option.id} className="flex min-w-0 items-center gap-1.5">
            <span className="sr-only">{option.name}</span>
            <select
              title={option.description ?? option.name}
              value={option.currentValue}
              disabled={disabled}
              onChange={(event) => onConfigChange(option.id, event.target.value)}
              className={selectClass}
            >
              {option.options.map((entry) =>
                isGroup(entry) ? (
                  <optgroup key={entry.group} label={entry.name}>
                    {entry.options.map((item) => (
                      <option key={item.value} value={item.value}>
                        {item.name}
                      </option>
                    ))}
                  </optgroup>
                ) : (
                  <option key={entry.value} value={entry.value}>
                    {entry.name}
                  </option>
                ),
              )}
            </select>
          </label>
        ),
      )}
    </div>
  );
}
