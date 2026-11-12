import { describe, expect, it } from "vitest";
import { LoopDetector } from "../../agent/loop-detector.js";

describe("agent/LoopDetector", () => {
  it("blocks identical calls on the configured repetition threshold", () => {
    const detector = new LoopDetector({ maxIdenticalCalls: 3 });
    expect(detector.recordToolCall("exec", '{"command":"echo hi"}').blocked).toBe(false);
    expect(detector.recordToolCall("exec", '{"command":"echo hi"}').blocked).toBe(false);
    const result = detector.recordToolCall("exec", '{"command":"echo hi"}');
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("identical arguments 3 times");
  });

  it("does not block the same tool when arguments change", () => {
    const detector = new LoopDetector({ maxIdenticalCalls: 3 });
    expect(detector.recordToolCall("exec", '{"command":"echo a"}').blocked).toBe(false);
    expect(detector.recordToolCall("exec", '{"command":"echo b"}').blocked).toBe(false);
    expect(detector.recordToolCall("exec", '{"command":"echo c"}').blocked).toBe(false);
  });

  it("warns on repeated turn patterns and blocks when ignored", () => {
    const detector = new LoopDetector();
    for (let i = 0; i < 2; i++) {
      detector.recordToolCall("exec", '{"command":"echo hi"}');
      expect(detector.endTurn().reason).toBe("");
    }

    detector.recordToolCall("exec", '{"command":"echo hi"}');
    const warning = detector.endTurn();
    expect(warning.blocked).toBe(false);
    expect(warning.reason).toContain("repeated the tool pattern");

    detector.recordToolCall("exec", '{"command":"echo hi"}');
    const blocked = detector.endTurn();
    expect(blocked.blocked).toBe(true);
    expect(blocked.reason).toContain("LOOP ENFORCEMENT");
  });

  it("flags idle-only streaks and reset clears state", () => {
    const detector = new LoopDetector({ maxIdleOnlyTurns: 3 });
    detector.recordToolCall("check_credits", '{}');
    expect(detector.endTurn().reason).toBe("");

    detector.recordToolCall("git_status", '{}');
    expect(detector.endTurn().reason).toBe("");

    detector.recordToolCall("list_models", '{}');
    const result = detector.endTurn();
    expect(result.blocked).toBe(false);
    expect(result.reason).toContain("IDLE LOOP DETECTED");

    detector.reset();
    detector.recordToolCall("exec", '{"command":"echo ok"}');
    expect(detector.endTurn().reason).toBe("");
  });

  it("treats read_file as investigative work, not an idle-only turn", () => {
    const detector = new LoopDetector({ maxIdleOnlyTurns: 2 });

    detector.recordToolCall("read_file", '{"path":"README.md"}');
    expect(detector.endTurn().reason).toBe("");

    detector.recordToolCall("check_credits", '{}');
    expect(detector.endTurn().reason).toBe("");

    detector.recordToolCall("list_models", '{}');
    expect(detector.endTurn().reason).toContain("IDLE LOOP DETECTED");
  });

  it("F024: one call per turn with different arguments is never blocked", () => {
    const detector = new LoopDetector();
    const results = ["npm install", "npm run build", "npm test", "git commit -m x", "git push", "ls"].map((command) => {
      expect(detector.recordToolCall("exec", JSON.stringify({ command })).blocked).toBe(false);
      return detector.endTurn();
    });
    expect(results.some((r) => r.blocked)).toBe(false);
    // A reminder at most.
    expect(results.filter((r) => r.reason.length > 0).length).toBeLessThanOrEqual(1);
  });

  it("F024: the same call with the same arguments every turn is still blocked", () => {
    const detector = new LoopDetector({ maxIdenticalCalls: 99 });
    const outcomes = [1, 2, 3, 4].map(() => {
      detector.recordToolCall("exec", '{"command":"npm test"}');
      return detector.endTurn();
    });
    expect(outcomes[2].reason).toContain("WARNING");
    expect(outcomes[3].blocked).toBe(true);
  });

  it("exempt tools (waits) are never counted as a loop", () => {
    const detector = new LoopDetector({ exemptTools: ["wait_for_tasks"] });
    for (let i = 0; i < 8; i++) {
      expect(detector.recordToolCall("wait_for_tasks", "{}").blocked).toBe(false);
      const turn = detector.endTurn();
      expect(turn.blocked).toBe(false);
      expect(turn.reason).toBe("");
    }
  });
  it("a wait between two identical status checks breaks the run, in calls and in turns", () => {
    const detector = new LoopDetector({ maxIdenticalCalls: 3, maxIdleOnlyTurns: 3, exemptTools: ["wait_for_tasks"] });
    const check = JSON.stringify({ task_id: "SUB1" });
    for (let cycle = 0; cycle < 6; cycle++) {
      expect(detector.recordToolCall("wait_for_tasks", '{"task_ids":["SUB1"]}').blocked).toBe(false);
      expect(detector.endTurn().blocked).toBe(false);
      expect(detector.recordToolCall("check_task_status", check).blocked).toBe(false);
      const turn = detector.endTurn();
      expect(turn.blocked).toBe(false);
      expect(turn.reason).not.toContain("WARNING");
    }
    // Same thing inside one turn.
    for (let cycle = 0; cycle < 6; cycle++) {
      detector.recordToolCall("wait_for_tasks", "{}");
      expect(detector.recordToolCall("check_task_status", check).blocked).toBe(false);
      expect(detector.endTurn().blocked).toBe(false);
    }
  });

  it("identical calls with no wait between them are still blocked", () => {
    const detector = new LoopDetector({ maxIdenticalCalls: 3, exemptTools: ["wait_for_tasks"] });
    detector.recordToolCall("wait_for_tasks", "{}");
    const check = JSON.stringify({ task_id: "SUB1" });
    expect(detector.recordToolCall("check_task_status", check).blocked).toBe(false);
    expect(detector.recordToolCall("check_task_status", check).blocked).toBe(false);
    expect(detector.recordToolCall("check_task_status", check).blocked).toBe(true);
  });
});
