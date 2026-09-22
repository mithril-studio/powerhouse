// Pure fold from raw ACP JSON-RPC lines to projection deltas. No I/O: the
// writer thread applies deltas incrementally and `telemetry_rebuild` replays
// stored raw events through this same code path, so both must agree by
// construction.
use serde_json::Value;
use std::collections::HashMap;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Direction {
    In,  // agent → client (stdout)
    Out, // client → agent (stdin)
    Err, // agent stderr
    Sys, // synthetic evidence rows (e.g. queue step summaries)
}

impl Direction {
    pub fn as_str(self) -> &'static str {
        match self {
            Direction::In => "in",
            Direction::Out => "out",
            Direction::Err => "err",
            Direction::Sys => "sys",
        }
    }

    pub fn parse(s: &str) -> Direction {
        match s {
            "out" => Direction::Out,
            "err" => Direction::Err,
            "sys" => Direction::Sys,
            _ => Direction::In,
        }
    }
}

pub struct ParsedLine {
    pub parse_status: &'static str, // 'ok' | 'invalid-json' | 'non-jsonrpc'
    pub method: Option<String>,
    pub is_response: bool,
    pub rpc_id: Option<String>,
    pub update_kind: Option<String>,
    pub event_time: Option<i64>,
    value: Option<Value>,
}

impl ParsedLine {
    /// Value stored in the `events.method` column: the method, or a marker
    /// for responses so the evidence view reads sensibly.
    pub fn method_label(&self) -> Option<String> {
        if self.is_response {
            Some("response".into())
        } else {
            self.method.clone()
        }
    }

    fn broken(parse_status: &'static str) -> ParsedLine {
        ParsedLine {
            parse_status,
            method: None,
            is_response: false,
            rpc_id: None,
            update_kind: None,
            event_time: None,
            value: None,
        }
    }
}

pub fn parse_line(raw: &str) -> ParsedLine {
    let value: Value = match serde_json::from_str(raw.trim()) {
        Ok(v) => v,
        Err(_) => return ParsedLine::broken("invalid-json"),
    };
    let Some(obj) = value.as_object() else {
        return ParsedLine::broken("non-jsonrpc");
    };
    let method = obj.get("method").and_then(|m| m.as_str()).map(String::from);
    let rpc_id = obj.get("id").map(|id| match id {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    });
    let is_response =
        method.is_none() && rpc_id.is_some() && (obj.contains_key("result") || obj.contains_key("error"));
    if method.is_none() && !is_response {
        return ParsedLine::broken("non-jsonrpc");
    }
    let update_kind = value
        .pointer("/params/update/sessionUpdate")
        .and_then(|k| k.as_str())
        .map(String::from);
    let event_time = ["/params/_meta/timestamp", "/params/update/_meta/timestamp"]
        .iter()
        .find_map(|p| value.pointer(p).and_then(|t| t.as_i64()));
    ParsedLine {
        parse_status: "ok",
        method,
        is_response,
        rpc_id,
        update_kind,
        event_time,
        value: Some(value),
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct UsageDelta {
    pub input: Option<i64>,
    pub output: Option<i64>,
    pub cached: Option<i64>,
    pub cost: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Delta {
    Session { session_id: String, resumed: bool },
    Agent { name: Option<String>, version: Option<String> },
    TurnOpen { idx: i64, prompt_seq: i64, preview: Option<String>, at: i64 },
    TurnClose { idx: i64, stop_reason: Option<String>, at: i64 },
    ToolUpsert {
        id: String,
        title: Option<String>,
        kind: Option<String>,
        status: Option<String>,
        turn_idx: Option<i64>,
        seq: i64,
        at: i64,
    },
    /// Execution context observed on the wire (last observation wins).
    Context { model: Option<String>, mode: Option<String> },
    Usage(UsageDelta),
    /// The event is a `session/load` history re-stream: flag it and count
    /// nothing, so replays never inflate totals.
    Replayed,
}

enum Pending {
    Prompt(i64),
    Initialize,
    NewSession,
    /// session/load and session/resume carry the session id in the request,
    /// not the response, so it is captured here.
    OldSession(Option<String>),
}

#[derive(Default)]
pub struct Projector {
    pending: HashMap<String, Pending>,
    /// rpc id of an in-flight session/load; updates until its response are replays.
    replay: Option<String>,
    open_turn: Option<i64>,
    next_turn: i64,
}

impl Projector {
    pub fn feed(&mut self, dir: Direction, seq: i64, now: i64, p: &ParsedLine) -> Vec<Delta> {
        if p.parse_status != "ok" {
            return Vec::new();
        }
        match dir {
            Direction::Out => self.feed_out(seq, now, p),
            Direction::In => self.feed_in(seq, now, p),
            _ => Vec::new(),
        }
    }

    fn feed_out(&mut self, seq: i64, now: i64, p: &ParsedLine) -> Vec<Delta> {
        // Outgoing responses (e.g. permission answers) and notifications carry
        // no projection state in milestone 1.
        let (Some(method), Some(id)) = (&p.method, &p.rpc_id) else {
            return Vec::new();
        };
        match method.as_str() {
            "session/prompt" => {
                let idx = self.next_turn;
                self.next_turn += 1;
                self.open_turn = Some(idx);
                self.pending.insert(id.clone(), Pending::Prompt(idx));
                let preview = p.value.as_ref().and_then(prompt_preview);
                vec![Delta::TurnOpen { idx, prompt_seq: seq, preview, at: now }]
            }
            "initialize" => {
                self.pending.insert(id.clone(), Pending::Initialize);
                Vec::new()
            }
            "session/new" => {
                self.pending.insert(id.clone(), Pending::NewSession);
                Vec::new()
            }
            "session/load" | "session/resume" => {
                let session_id = p
                    .value
                    .as_ref()
                    .and_then(|v| v.pointer("/params/sessionId"))
                    .and_then(|s| s.as_str())
                    .map(String::from);
                self.pending.insert(id.clone(), Pending::OldSession(session_id));
                if method == "session/load" {
                    self.replay = Some(id.clone());
                }
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn feed_in(&mut self, seq: i64, now: i64, p: &ParsedLine) -> Vec<Delta> {
        if p.is_response {
            let Some(id) = &p.rpc_id else { return Vec::new() };
            if self.replay.as_deref() == Some(id.as_str()) {
                self.replay = None;
            }
            let Some(pending) = self.pending.remove(id) else {
                return Vec::new();
            };
            let value = p.value.as_ref();
            match pending {
                Pending::Prompt(idx) => {
                    if self.open_turn == Some(idx) {
                        self.open_turn = None;
                    }
                    let stop_reason = value
                        .and_then(|v| v.pointer("/result/stopReason"))
                        .and_then(|s| s.as_str())
                        .map(String::from)
                        .or_else(|| {
                            value
                                .and_then(|v| v.get("error"))
                                .map(|_| "error".to_string())
                        });
                    let mut deltas = vec![Delta::TurnClose { idx, stop_reason, at: now }];
                    if let Some(usage) = value.and_then(extract_usage) {
                        deltas.push(Delta::Usage(usage));
                    }
                    deltas
                }
                Pending::Initialize => {
                    let info = value.and_then(|v| {
                        v.pointer("/result/agentInfo")
                            .or_else(|| v.pointer("/result/serverInfo"))
                    });
                    let name = info
                        .and_then(|i| i.get("name"))
                        .and_then(|s| s.as_str())
                        .map(String::from);
                    let version = info
                        .and_then(|i| i.get("version"))
                        .and_then(|s| s.as_str())
                        .map(String::from);
                    if name.is_none() && version.is_none() {
                        Vec::new()
                    } else {
                        vec![Delta::Agent { name, version }]
                    }
                }
                Pending::NewSession => {
                    let mut deltas: Vec<Delta> = value
                        .and_then(|v| v.pointer("/result/sessionId"))
                        .and_then(|s| s.as_str())
                        .map(|sid| vec![Delta::Session { session_id: sid.into(), resumed: false }])
                        .unwrap_or_default();
                    deltas.extend(value.and_then(context_from_session_result));
                    deltas
                }
                Pending::OldSession(sid) => {
                    let mut deltas: Vec<Delta> = sid
                        .map(|sid| vec![Delta::Session { session_id: sid, resumed: true }])
                        .unwrap_or_default();
                    deltas.extend(value.and_then(context_from_session_result));
                    deltas
                }
            }
        } else if p.method.as_deref() == Some("session/update") {
            if self.replay.is_some() {
                return vec![Delta::Replayed];
            }
            let mut deltas = Vec::new();
            let update = p.value.as_ref().and_then(|v| v.pointer("/params/update"));
            match p.update_kind.as_deref() {
                Some("current_mode_update") => {
                    if let Some(mode) = update
                        .and_then(|u| u.get("currentModeId"))
                        .and_then(|s| s.as_str())
                    {
                        deltas.push(Delta::Context { model: None, mode: Some(mode.into()) });
                    }
                }
                Some("config_option_update") => {
                    if let Some(model) = update.and_then(model_from_config_options) {
                        deltas.push(Delta::Context { model: Some(model), mode: None });
                    }
                }
                _ => {}
            }
            if matches!(p.update_kind.as_deref(), Some("tool_call") | Some("tool_call_update")) {
                if let Some(id) = update
                    .and_then(|u| u.get("toolCallId"))
                    .and_then(|s| s.as_str())
                {
                    let get = |key: &str| {
                        update
                            .and_then(|u| u.get(key))
                            .and_then(|s| s.as_str())
                            .map(String::from)
                    };
                    deltas.push(Delta::ToolUpsert {
                        id: id.into(),
                        title: get("title"),
                        kind: get("kind"),
                        status: get("status"),
                        turn_idx: self.open_turn,
                        seq,
                        at: now,
                    });
                }
            }
            if let Some(usage) = p.value.as_ref().and_then(extract_usage) {
                deltas.push(Delta::Usage(usage));
            }
            deltas
        } else {
            // Agent → client requests (e.g. session/request_permission):
            // envelope-only in milestone 1.
            Vec::new()
        }
    }
}

/// Model/mode context from a session/new|load|resume response: ACP advertises
/// modes as `modes.currentModeId` and the model as a config option with
/// `category == "model"` and a `currentValue`.
fn context_from_session_result(value: &Value) -> Option<Delta> {
    let mode = value
        .pointer("/result/modes/currentModeId")
        .and_then(|s| s.as_str())
        .map(String::from);
    let model = value.pointer("/result").and_then(model_from_config_options);
    if mode.is_none() && model.is_none() {
        None
    } else {
        Some(Delta::Context { model, mode })
    }
}

/// Finds the `model`-category option's current value in a `configOptions`
/// array (or a single `option` object on updates).
fn model_from_config_options(scope: &Value) -> Option<String> {
    let candidates = scope
        .get("configOptions")
        .and_then(|o| o.as_array())
        .map(|a| a.iter().collect::<Vec<_>>())
        .or_else(|| scope.get("option").map(|o| vec![o]))?;
    candidates.iter().find_map(|option| {
        if option.get("category").and_then(|c| c.as_str()) != Some("model") {
            return None;
        }
        let current = option.get("currentValue")?;
        match current {
            Value::String(s) => Some(s.clone()),
            other => Some(other.to_string()),
        }
    })
}

/// Best-effort token/cost extraction. Adapters differ in where (and whether)
/// they report usage; absence means UNKNOWN and must return None, never zeros.
pub fn extract_usage(value: &Value) -> Option<UsageDelta> {
    const SPOTS: [&str; 7] = [
        "/usage",
        "/result/usage",
        "/result/_meta/usage",
        "/_meta/usage",
        "/params/update/usage",
        "/params/update/_meta/usage",
        "/params/usage",
    ];
    let spot = SPOTS.iter().find_map(|p| value.pointer(p))?;
    let int = |keys: &[&str]| keys.iter().find_map(|k| spot.get(k).and_then(|v| v.as_i64()));
    let usage = UsageDelta {
        input: int(&["inputTokens", "input_tokens"]),
        output: int(&["outputTokens", "output_tokens"]),
        cached: int(&[
            "cachedTokens",
            "cached_tokens",
            "cacheReadInputTokens",
            "cache_read_input_tokens",
        ]),
        cost: ["costUsd", "cost_usd", "totalCostUsd", "total_cost_usd", "cost"]
            .iter()
            .find_map(|k| spot.get(*k).and_then(|v| v.as_f64())),
    };
    if usage == UsageDelta::default() {
        None
    } else {
        Some(usage)
    }
}

const PREVIEW_CAP: usize = 160;

fn prompt_preview(value: &Value) -> Option<String> {
    let blocks = value.pointer("/params/prompt")?.as_array()?;
    let text = blocks
        .iter()
        .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
        .collect::<Vec<_>>()
        .join(" ");
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return None;
    }
    let mut cut = PREVIEW_CAP.min(text.len());
    while cut < text.len() && !text.is_char_boundary(cut) {
        cut += 1;
    }
    Some(text[..cut].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_all(lines: &[(Direction, &str)]) -> Vec<Delta> {
        let mut proj = Projector::default();
        let mut all = Vec::new();
        for (i, (dir, raw)) in lines.iter().enumerate() {
            let parsed = parse_line(raw);
            all.extend(proj.feed(*dir, i as i64 + 1, 1000 + i as i64, &parsed));
        }
        all
    }

    #[test]
    fn classifies_parse_status() {
        assert_eq!(parse_line("not json").parse_status, "invalid-json");
        assert_eq!(parse_line("[1,2]").parse_status, "non-jsonrpc");
        assert_eq!(parse_line("{\"foo\":1}").parse_status, "non-jsonrpc");
        let ok = parse_line("{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{}}");
        assert_eq!(ok.parse_status, "ok");
        assert!(ok.is_response);
        assert_eq!(ok.method_label().as_deref(), Some("response"));
        assert_eq!(ok.rpc_id.as_deref(), Some("7"));
    }

    #[test]
    fn projects_a_full_turn_with_tool_calls_and_usage() {
        let deltas = feed_all(&[
            (Direction::Out, r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#),
            (Direction::In, r#"{"jsonrpc":"2.0","id":1,"result":{"agentInfo":{"name":"claude-agent","version":"1.2"}}}"#),
            (Direction::Out, r#"{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/x"}}"#),
            (Direction::In, r#"{"jsonrpc":"2.0","id":2,"result":{"sessionId":"sess-1"}}"#),
            (Direction::Out, r#"{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"sess-1","prompt":[{"type":"text","text":"  hello   world  "}]}}"#),
            (Direction::In, r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess-1","update":{"sessionUpdate":"tool_call","toolCallId":"t1","title":"Read file","kind":"read","status":"in_progress"}}}"#),
            (Direction::In, r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess-1","update":{"sessionUpdate":"tool_call_update","toolCallId":"t1","status":"completed"}}}"#),
            (Direction::In, r#"{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn","usage":{"inputTokens":100,"outputTokens":25}}}"#),
        ]);

        assert_eq!(
            deltas,
            vec![
                Delta::Agent { name: Some("claude-agent".into()), version: Some("1.2".into()) },
                Delta::Session { session_id: "sess-1".into(), resumed: false },
                Delta::TurnOpen { idx: 0, prompt_seq: 5, preview: Some("hello world".into()), at: 1004 },
                Delta::ToolUpsert {
                    id: "t1".into(),
                    title: Some("Read file".into()),
                    kind: Some("read".into()),
                    status: Some("in_progress".into()),
                    turn_idx: Some(0),
                    seq: 6,
                    at: 1005,
                },
                Delta::ToolUpsert {
                    id: "t1".into(),
                    title: None,
                    kind: None,
                    status: Some("completed".into()),
                    turn_idx: Some(0),
                    seq: 7,
                    at: 1006,
                },
                Delta::TurnClose { idx: 0, stop_reason: Some("end_turn".into()), at: 1007 },
                Delta::Usage(UsageDelta { input: Some(100), output: Some(25), cached: None, cost: None }),
            ]
        );
    }

    #[test]
    fn session_load_marks_history_as_replayed_and_resumed() {
        let deltas = feed_all(&[
            (Direction::Out, r#"{"jsonrpc":"2.0","id":1,"method":"session/load","params":{"sessionId":"sess-9"}}"#),
            (Direction::In, r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"old","status":"completed"}}}"#),
            (Direction::In, r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk"}}}"#),
            (Direction::In, r#"{"jsonrpc":"2.0","id":1,"result":{}}"#),
            (Direction::In, r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"new","status":"pending"}}}"#),
        ]);

        assert_eq!(deltas[0], Delta::Replayed);
        assert_eq!(deltas[1], Delta::Replayed);
        assert_eq!(deltas[2], Delta::Session { session_id: "sess-9".into(), resumed: true });
        assert!(matches!(&deltas[3], Delta::ToolUpsert { id, .. } if id == "new"));
        assert_eq!(deltas.len(), 4);
    }

    #[test]
    fn absent_usage_stays_unknown() {
        let deltas = feed_all(&[
            (Direction::Out, r#"{"jsonrpc":"2.0","id":1,"method":"session/prompt","params":{"prompt":[{"type":"text","text":"hi"}]}}"#),
            (Direction::In, r#"{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}"#),
        ]);
        assert!(!deltas.iter().any(|d| matches!(d, Delta::Usage(_))));
    }

    #[test]
    fn prompt_error_response_closes_the_turn() {
        let deltas = feed_all(&[
            (Direction::Out, r#"{"jsonrpc":"2.0","id":1,"method":"session/prompt","params":{"prompt":[]}}"#),
            (Direction::In, r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"boom"}}"#),
        ]);
        assert_eq!(deltas[1], Delta::TurnClose { idx: 0, stop_reason: Some("error".into()), at: 1001 });
    }

    #[test]
    fn captures_model_and_mode_context() {
        let deltas = feed_all(&[
            (Direction::Out, r#"{"jsonrpc":"2.0","id":1,"method":"session/new","params":{}}"#),
            (Direction::In, r#"{"jsonrpc":"2.0","id":1,"result":{"sessionId":"s","modes":{"currentModeId":"default"},"configOptions":[{"id":"m","category":"model","type":"select","currentValue":"claude-sonnet-5"}]}}"#),
            (Direction::In, r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"current_mode_update","currentModeId":"plan"}}}"#),
            (Direction::In, r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"config_option_update","configOptions":[{"id":"m","category":"model","currentValue":"claude-opus-5"}]}}}"#),
        ]);
        assert_eq!(
            deltas,
            vec![
                Delta::Session { session_id: "s".into(), resumed: false },
                Delta::Context { model: Some("claude-sonnet-5".into()), mode: Some("default".into()) },
                Delta::Context { model: None, mode: Some("plan".into()) },
                Delta::Context { model: Some("claude-opus-5".into()), mode: None },
            ]
        );
    }

    #[test]
    fn extracts_usage_from_alternate_shapes() {
        let v: Value = serde_json::from_str(
            r#"{"params":{"update":{"_meta":{"usage":{"input_tokens":5,"cache_read_input_tokens":3,"total_cost_usd":0.01}}}}}"#,
        )
        .unwrap();
        assert_eq!(
            extract_usage(&v),
            Some(UsageDelta { input: Some(5), output: None, cached: Some(3), cost: Some(0.01) })
        );
        assert_eq!(extract_usage(&serde_json::json!({"result":{}})), None);
        assert_eq!(extract_usage(&serde_json::json!({"result":{"usage":{}}})), None);
    }
}
