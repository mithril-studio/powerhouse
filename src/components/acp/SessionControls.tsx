import { resolveModels, resolveModes, resolveReasoning, type AgentControlState, type ApplyOp, type Selector, type Unsupported } from "../../lib/agentControls";

function SessionSelect({ selector, disabled, onApply }: { selector: Selector | Unsupported; disabled: boolean; onApply: (op: ApplyOp) => void }) {
  if (!selector.supported || selector.options.length === 0) return null;
  return (
    <label className="session-control" title={selector.title}>
      <span className="sr-only">{selector.title}</span>
      <select aria-label={selector.title} value={selector.current?.id ?? ""} disabled={disabled} onChange={(event) => {
        const option = selector.options.find((item) => item.id === event.target.value);
        if (option) onApply(option.apply);
      }}>
        {!selector.current && <option value="" disabled>{selector.title}</option>}
        {selector.options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
    </label>
  );
}

/** Only offer capabilities the connected agent actually advertises. */
export function SessionControls({ state, disabled, onApply }: { state: AgentControlState; disabled: boolean; onApply: (op: ApplyOp) => void }) {
  return <>
    <SessionSelect selector={resolveModels(state)} disabled={disabled} onApply={onApply} />
    <SessionSelect selector={resolveModes(state)} disabled={disabled} onApply={onApply} />
    <SessionSelect selector={resolveReasoning(state)} disabled={disabled} onApply={onApply} />
  </>;
}
