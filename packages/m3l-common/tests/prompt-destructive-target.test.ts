/**
 * Tests for the A2 target-graded destructive confirmation gate.
 *
 * Contract source: docs/reference/core/prompt.md § confirmDestructive / Target grading
 * ADR: docs/adr/0048-target-graded-destructive-confirmation.md
 *
 * New symbols under test (not yet implemented — this suite must run RED):
 *   - M3LDestructiveTarget, M3LDestructiveTargetPredicate, M3LSensitiveTargetSpec (types)
 *   - sensitiveTargets(spec) (function)
 *   - confirmDestructive gains optional target, isSensitiveTarget, yesSensitive fields
 *
 * Five-state matrix:
 *   1. No target          → identical to ungraded; yesSensitive is ignored
 *   2. Target, not sensitive → identical to ungraded (same bypass text, same confirm msg)
 *   3. Sensitive, yes + yesSensitive both true → bypass; warning names target; no prompt calls
 *   4. Sensitive, yes:true, yesSensitive absent/false → STILL escalates; prompt.text called (ADR-0048)
 *   5. Sensitive, not bypassed → typed-echo via prompt.text, not prompt.confirm
 */

import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import { M3LError } from "../src/core/errors/index.js";
import { M3LLogger } from "../src/core/logging/index.js";
import {
  confirmDestructive,
  M3LPrompt,
  sensitiveTargets,
} from "../src/core/prompt/index.js";
import { escapeTerminalControls } from "../src/internal/prompt/sanitize.js";

import type {
  M3LConfirmDestructiveOptions,
  M3LDestructiveTarget,
  M3LDestructiveTargetPredicate,
  M3LSensitiveTargetSpec,
} from "../src/core/prompt/index.js";

// ---------------------------------------------------------------------------
// Shared fixture factories
// ---------------------------------------------------------------------------

function makePromptAndLogger() {
  return {
    prompt: new M3LPrompt(),
    logger: new M3LLogger([]),
  };
}

const PROD_TARGET: M3LDestructiveTarget = {
  profile: "prod",
  region: "us-east-1",
};

const PROD_TARGET_WITH_ACCOUNT: M3LDestructiveTarget = {
  profile: "prod",
  region: "us-east-1",
  accountId: "123456789012",
};

const alwaysSensitive: M3LDestructiveTargetPredicate = () => true;
const neverSensitive: M3LDestructiveTargetPredicate = () => false;

// ---------------------------------------------------------------------------
// Cleanup — vi.restoreAllMocks() undoes all vi.spyOn wrappers added per test.
// No vi.mock() factories are used here so no vi.fn().mockReset() is needed.
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// State 1 — no target
// ---------------------------------------------------------------------------

describe("state 1: no target supplied", () => {
  test("yes:true without target bypasses via warning, never calls prompt.confirm or prompt.text", async () => {
    const { prompt, logger } = makePromptAndLogger();
    const confirm = vi.spyOn(prompt, "confirm");
    const text = vi.spyOn(prompt, "text");
    const warning = vi.spyOn(logger, "warning");

    await expect(
      confirmDestructive({
        prompt,
        logger,
        description: "delete cluster a",
        yes: true,
        code: "ERR_ABORTED",
      }),
    ).resolves.toBeUndefined();

    expect(warning).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  test("yes:true, yesSensitive:true without target — yesSensitive is ignored, still bypasses via the standard warning (no target to name)", async () => {
    const { prompt, logger } = makePromptAndLogger();
    const confirm = vi.spyOn(prompt, "confirm");
    const text = vi.spyOn(prompt, "text");
    const warning = vi.spyOn(logger, "warning");

    await expect(
      confirmDestructive({
        prompt,
        logger,
        description: "delete cluster a",
        yes: true,
        yesSensitive: true,
        code: "ERR_ABORTED",
      }),
    ).resolves.toBeUndefined();

    // yesSensitive is meaningless without a target: the standard bypass fires.
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0]?.[0]).toBe(
      "destructive confirmation bypassed (yes=true): delete cluster a",
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  test("yes:false, yesSensitive:true without target — yesSensitive is ignored, prompt.confirm is still called (not prompt.text)", async () => {
    const { prompt, logger } = makePromptAndLogger();
    const confirm = vi.spyOn(prompt, "confirm").mockResolvedValue(true);
    const text = vi.spyOn(prompt, "text");

    await expect(
      confirmDestructive({
        prompt,
        logger,
        description: "delete cluster a",
        yes: false,
        yesSensitive: true,
        code: "ERR_ABORTED",
      }),
    ).resolves.toBeUndefined();

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(text).not.toHaveBeenCalled();
  });

  test("isSensitiveTarget is never called when target is absent", async () => {
    const { prompt, logger } = makePromptAndLogger();
    vi.spyOn(prompt, "confirm").mockResolvedValue(true);
    const predicate = vi.fn(() => true);

    await confirmDestructive({
      prompt,
      logger,
      description: "delete cluster a",
      yes: false,
      isSensitiveTarget: predicate,
      code: "ERR_ABORTED",
    });

    expect(predicate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// State 2 — target supplied, not sensitive
// ---------------------------------------------------------------------------

describe("state 2: target supplied, not sensitive", () => {
  test("yes:true + non-sensitive target → bypass warning matches standard text (unchanged)", async () => {
    const { prompt, logger } = makePromptAndLogger();
    const confirm = vi.spyOn(prompt, "confirm");
    const text = vi.spyOn(prompt, "text");
    const warning = vi.spyOn(logger, "warning");

    await expect(
      confirmDestructive({
        prompt,
        logger,
        description: "delete cluster b",
        yes: true,
        code: "ERR_ABORTED",
        target: PROD_TARGET,
        isSensitiveTarget: neverSensitive,
      }),
    ).resolves.toBeUndefined();

    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0]?.[0]).toBe(
      "destructive confirmation bypassed (yes=true): delete cluster b",
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  test("yes:false + non-sensitive target → prompt.confirm called with same message as ungraded (Confirm: <desc>?)", async () => {
    const { prompt, logger } = makePromptAndLogger();
    const confirm = vi.spyOn(prompt, "confirm").mockResolvedValue(true);
    const text = vi.spyOn(prompt, "text");

    await expect(
      confirmDestructive({
        prompt,
        logger,
        description: "delete cluster b",
        yes: false,
        code: "ERR_ABORTED",
        target: PROD_TARGET,
        isSensitiveTarget: neverSensitive,
      }),
    ).resolves.toBeUndefined();

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]?.[0]).toBe("Confirm: delete cluster b?");
    expect(text).not.toHaveBeenCalled();
  });

  test("yes:false + non-sensitive target, confirm resolves false → throws M3LError aborted:<desc> with caller code", async () => {
    const { prompt, logger } = makePromptAndLogger();
    vi.spyOn(prompt, "confirm").mockResolvedValue(false);

    let thrown: unknown;
    try {
      await confirmDestructive({
        prompt,
        logger,
        description: "delete cluster b",
        yes: false,
        code: "ERR_STATE2_ABORTED",
        target: PROD_TARGET,
        isSensitiveTarget: neverSensitive,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).message).toBe("aborted: delete cluster b");
    expect((thrown as M3LError).code).toBe("ERR_STATE2_ABORTED");
  });

  test("isSensitiveTarget is called once with the target when target is supplied", async () => {
    const { prompt, logger } = makePromptAndLogger();
    vi.spyOn(prompt, "confirm").mockResolvedValue(true);
    const predicate = vi.fn(() => false);

    await confirmDestructive({
      prompt,
      logger,
      description: "delete cluster b",
      yes: false,
      code: "ERR_ABORTED",
      target: PROD_TARGET,
      isSensitiveTarget: predicate,
    });

    expect(predicate).toHaveBeenCalledTimes(1);
    expect(predicate).toHaveBeenCalledWith(PROD_TARGET);
  });
});

// ---------------------------------------------------------------------------
// State 3 — sensitive + yes:true + yesSensitive:true → bypass naming the target
// ---------------------------------------------------------------------------

describe("state 3: sensitive + yes:true + yesSensitive:true → bypassed, warning names target", () => {
  test("resolves without calling prompt.confirm or prompt.text", async () => {
    const { prompt, logger } = makePromptAndLogger();
    const confirm = vi.spyOn(prompt, "confirm");
    const text = vi.spyOn(prompt, "text");
    vi.spyOn(logger, "warning");

    await expect(
      confirmDestructive({
        prompt,
        logger,
        description: "nuke prod cluster",
        yes: true,
        yesSensitive: true,
        code: "ERR_ABORTED",
        target: PROD_TARGET,
        isSensitiveTarget: alwaysSensitive,
      }),
    ).resolves.toBeUndefined();

    expect(confirm).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  test("logs exactly one warning that contains the profile and region", async () => {
    const { prompt, logger } = makePromptAndLogger();
    const warning = vi.spyOn(logger, "warning");

    await confirmDestructive({
      prompt,
      logger,
      description: "nuke prod cluster",
      yes: true,
      yesSensitive: true,
      code: "ERR_ABORTED",
      target: PROD_TARGET,
      isSensitiveTarget: alwaysSensitive,
    });

    expect(warning).toHaveBeenCalledTimes(1);
    const msg = warning.mock.calls[0]?.[0] as string;
    expect(msg).toContain("prod");
    expect(msg).toContain("us-east-1");
  });

  test("warning message also contains accountId when present", async () => {
    const { prompt, logger } = makePromptAndLogger();
    const warning = vi.spyOn(logger, "warning");

    await confirmDestructive({
      prompt,
      logger,
      description: "nuke prod cluster",
      yes: true,
      yesSensitive: true,
      code: "ERR_ABORTED",
      target: PROD_TARGET_WITH_ACCOUNT,
      isSensitiveTarget: alwaysSensitive,
    });

    const msg = warning.mock.calls[0]?.[0] as string;
    expect(msg).toContain("123456789012");
  });

  test("bypass warning escapes target fields containing control characters", async () => {
    const { prompt, logger } = makePromptAndLogger();
    const warning = vi.spyOn(logger, "warning");

    const rawProfile = "prod\x09env"; // U+0009 tab (Cc)
    const escapedProfile = escapeTerminalControls(rawProfile);

    await confirmDestructive({
      prompt,
      logger,
      description: "nuke cluster",
      yes: true,
      yesSensitive: true,
      code: "ERR_ABORTED",
      target: { profile: rawProfile, region: "us-east-1" },
      isSensitiveTarget: alwaysSensitive,
    });

    const msg = warning.mock.calls[0]?.[0] as string;
    // The escaped form must appear in the warning.
    expect(msg).toContain(escapedProfile);
    // The raw control character must NOT appear literally.
    expect(msg).not.toContain(rawProfile);
  });
});

// ---------------------------------------------------------------------------
// State 4 (HEADLINE — ADR-0048): sensitive + yes:true + yesSensitive absent or false
//   → plain `yes` does NOT bypass; escalates to typed echo
// ---------------------------------------------------------------------------

describe("state 4 (HEADLINE — ADR-0048): sensitive + yes:true but yesSensitive absent/false → still escalates", () => {
  test("yesSensitive:false — prompt.text is called and no bypass warning is logged", async () => {
    const { prompt, logger } = makePromptAndLogger();
    const text = vi.spyOn(prompt, "text").mockResolvedValue("prod");
    const confirm = vi.spyOn(prompt, "confirm");
    const warning = vi.spyOn(logger, "warning");

    await expect(
      confirmDestructive({
        prompt,
        logger,
        description: "nuke prod cluster",
        yes: true,
        yesSensitive: false,
        code: "ERR_ABORTED",
        target: PROD_TARGET,
        isSensitiveTarget: alwaysSensitive,
      }),
    ).resolves.toBeUndefined();

    expect(text).toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
  });

  test("yesSensitive absent — prompt.text is called and no bypass warning is logged", async () => {
    const { prompt, logger } = makePromptAndLogger();
    const text = vi.spyOn(prompt, "text").mockResolvedValue("prod");
    const confirm = vi.spyOn(prompt, "confirm");
    const warning = vi.spyOn(logger, "warning");

    await expect(
      confirmDestructive({
        prompt,
        logger,
        description: "nuke prod cluster",
        yes: true,
        code: "ERR_ABORTED",
        target: PROD_TARGET,
        isSensitiveTarget: alwaysSensitive,
      }),
    ).resolves.toBeUndefined();

    expect(text).toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// State 5 — sensitive, not bypassed → escalated typed-echo via prompt.text
// ---------------------------------------------------------------------------

describe("state 5: sensitive, not bypassed → escalated typed-echo", () => {
  test("prompt.text is called (not prompt.confirm) when target is sensitive", async () => {
    const { prompt, logger } = makePromptAndLogger();
    const text = vi.spyOn(prompt, "text").mockResolvedValue("prod");
    // Mock confirm to prevent the unimplemented path from hanging on terminal input.
    const confirm = vi.spyOn(prompt, "confirm").mockResolvedValue(true);

    await confirmDestructive({
      prompt,
      logger,
      description: "nuke prod cluster",
      yes: false,
      code: "ERR_ABORTED",
      target: PROD_TARGET,
      isSensitiveTarget: alwaysSensitive,
    });

    expect(text).toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  test("prompt.text message names profile and region (no accountId)", async () => {
    const { prompt, logger } = makePromptAndLogger();
    const text = vi.spyOn(prompt, "text").mockResolvedValue("prod");
    // Mock confirm to prevent the unimplemented path from hanging on terminal input.
    vi.spyOn(prompt, "confirm").mockResolvedValue(true);

    await confirmDestructive({
      prompt,
      logger,
      description: "nuke prod cluster",
      yes: false,
      code: "ERR_ABORTED",
      target: PROD_TARGET,
      isSensitiveTarget: alwaysSensitive,
    });

    expect(text).toHaveBeenCalledTimes(1);
    const msg = text.mock.calls[0]?.[0] as string;
    expect(msg).toContain("prod");
    expect(msg).toContain("us-east-1");
  });

  test("prompt.text message names accountId when present", async () => {
    const { prompt, logger } = makePromptAndLogger();
    const text = vi.spyOn(prompt, "text").mockResolvedValue("prod");
    // Mock confirm to prevent the unimplemented path from hanging on terminal input.
    vi.spyOn(prompt, "confirm").mockResolvedValue(true);

    await confirmDestructive({
      prompt,
      logger,
      description: "nuke prod cluster",
      yes: false,
      code: "ERR_ABORTED",
      target: PROD_TARGET_WITH_ACCOUNT,
      isSensitiveTarget: alwaysSensitive,
    });

    const msg = text.mock.calls[0]?.[0] as string;
    expect(msg).toContain("123456789012");
  });

  test("exact match resolves", async () => {
    const { prompt, logger } = makePromptAndLogger();
    vi.spyOn(prompt, "text").mockResolvedValue("prod");
    // Mock confirm to return false: if the unimplemented path falls through to
    // confirm (which returns false and throws), the test fails in RED; the
    // correct impl calls text, gets "prod", matches, and resolves in GREEN.
    vi.spyOn(prompt, "confirm").mockResolvedValue(false);

    await expect(
      confirmDestructive({
        prompt,
        logger,
        description: "nuke prod cluster",
        yes: false,
        code: "ERR_ABORTED",
        target: PROD_TARGET,
        isSensitiveTarget: alwaysSensitive,
      }),
    ).resolves.toBeUndefined();
  });

  test("trimmed whitespace match resolves (leading/trailing spaces stripped before comparison)", async () => {
    const { prompt, logger } = makePromptAndLogger();
    vi.spyOn(prompt, "text").mockResolvedValue("  prod  ");
    // Mock confirm to return false: RED fails (confirm throws), GREEN resolves via text trim match.
    vi.spyOn(prompt, "confirm").mockResolvedValue(false);

    await expect(
      confirmDestructive({
        prompt,
        logger,
        description: "nuke prod cluster",
        yes: false,
        code: "ERR_ABORTED",
        target: PROD_TARGET,
        isSensitiveTarget: alwaysSensitive,
      }),
    ).resolves.toBeUndefined();
  });

  test("mismatched input throws M3LError with aborted:<desc> and caller code", async () => {
    const { prompt, logger } = makePromptAndLogger();
    vi.spyOn(prompt, "text").mockResolvedValue("nope");
    // Mock confirm to return true: if the unimplemented path falls through to
    // confirm (resolves, no throw), thrown stays undefined and the
    // toBeInstanceOf(M3LError) assertion fails in RED. In GREEN, text is called
    // with "nope" ≠ "prod", throwing M3LError with ERR_ECHO_MISMATCH.
    vi.spyOn(prompt, "confirm").mockResolvedValue(true);

    let thrown: unknown;
    try {
      await confirmDestructive({
        prompt,
        logger,
        description: "nuke prod cluster",
        yes: false,
        code: "ERR_ECHO_MISMATCH",
        target: PROD_TARGET,
        isSensitiveTarget: alwaysSensitive,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).message).toBe("aborted: nuke prod cluster");
    expect((thrown as M3LError).code).toBe("ERR_ECHO_MISMATCH");
  });

  test("empty string input throws M3LError with aborted:<desc>", async () => {
    const { prompt, logger } = makePromptAndLogger();
    vi.spyOn(prompt, "text").mockResolvedValue("");
    // confirm returns true: if unimplemented path resolves without throw,
    // thrown is undefined → toBeInstanceOf(M3LError) fails in RED.
    vi.spyOn(prompt, "confirm").mockResolvedValue(true);

    let thrown: unknown;
    try {
      await confirmDestructive({
        prompt,
        logger,
        description: "nuke prod cluster",
        yes: false,
        code: "ERR_ECHO_EMPTY",
        target: PROD_TARGET,
        isSensitiveTarget: alwaysSensitive,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).message).toBe("aborted: nuke prod cluster");
    expect((thrown as M3LError).code).toBe("ERR_ECHO_EMPTY");
  });

  test("rejection from prompt.text propagates unchanged (not converted to aborted error)", async () => {
    const { prompt, logger } = makePromptAndLogger();
    const cancellation = new Error("prompt was cancelled");
    vi.spyOn(prompt, "text").mockRejectedValue(cancellation);
    // confirm returns true (resolves): if the unimplemented path falls through
    // to confirm, the function resolves instead of rejecting with `cancellation`
    // → rejects.toBe(cancellation) fails in RED. In GREEN, text rejects with
    // `cancellation`, which propagates unchanged.
    vi.spyOn(prompt, "confirm").mockResolvedValue(true);

    await expect(
      confirmDestructive({
        prompt,
        logger,
        description: "nuke prod cluster",
        yes: false,
        code: "ERR_ABORTED",
        target: PROD_TARGET,
        isSensitiveTarget: alwaysSensitive,
      }),
    ).rejects.toBe(cancellation);
  });

  test("thrown message on mismatch does NOT contain the profile or region (no target fields leak into error)", async () => {
    const { prompt, logger } = makePromptAndLogger();
    vi.spyOn(prompt, "text").mockResolvedValue("wrong-input");
    // confirm returns true: if unimplemented path resolves, thrown is undefined
    // → toBeInstanceOf(M3LError) fails in RED, proving the test discriminates.
    vi.spyOn(prompt, "confirm").mockResolvedValue(true);

    let thrown: unknown;
    try {
      await confirmDestructive({
        prompt,
        logger,
        description: "nuke cluster",
        yes: false,
        code: "ERR_ABORTED",
        target: PROD_TARGET,
        isSensitiveTarget: alwaysSensitive,
      });
    } catch (error) {
      thrown = error;
    }

    // Must be an M3LError; if impl resolved (no throw) this fails in RED.
    expect(thrown).toBeInstanceOf(M3LError);
    const msg = (thrown as M3LError).message;
    expect(msg).not.toContain("prod");
    expect(msg).not.toContain("us-east-1");
  });

  describe("display escaped, comparison raw (control characters in profile)", () => {
    const RAW_PROFILE = "prod\x09env"; // tab U+0009 is Cc
    const TARGET_WITH_CONTROL: M3LDestructiveTarget = {
      profile: RAW_PROFILE,
      region: "us-east-1",
    };

    test("prompt.text message contains the ESCAPED profile, not the raw bytes", async () => {
      const { prompt, logger } = makePromptAndLogger();
      const text = vi.spyOn(prompt, "text").mockResolvedValue(RAW_PROFILE);
      // Mock confirm to prevent the unimplemented path from hanging on terminal input.
      vi.spyOn(prompt, "confirm").mockResolvedValue(true);
      const escapedProfile = escapeTerminalControls(RAW_PROFILE);

      await confirmDestructive({
        prompt,
        logger,
        description: "nuke controlled cluster",
        yes: false,
        code: "ERR_ABORTED",
        target: TARGET_WITH_CONTROL,
        isSensitiveTarget: alwaysSensitive,
      });

      const msg = text.mock.calls[0]?.[0] as string;
      expect(msg).toContain(escapedProfile);
      // The raw profile (with the literal tab byte) must not appear unescaped.
      expect(msg).not.toContain(RAW_PROFILE);
    });

    test("comparison uses the RAW profile — typing the raw value (with control char) resolves", async () => {
      const { prompt, logger } = makePromptAndLogger();
      // The user types the raw profile (including the tab byte).
      vi.spyOn(prompt, "text").mockResolvedValue(RAW_PROFILE);
      // confirm returns false: if impl falls through to confirm, it throws
      // → test expects resolve → fails in RED. In GREEN, text returns
      // RAW_PROFILE, trim matches raw profile, resolves.
      vi.spyOn(prompt, "confirm").mockResolvedValue(false);

      await expect(
        confirmDestructive({
          prompt,
          logger,
          description: "nuke controlled cluster",
          yes: false,
          code: "ERR_ABORTED",
          target: TARGET_WITH_CONTROL,
          isSensitiveTarget: alwaysSensitive,
        }),
      ).resolves.toBeUndefined();
    });

    test("comparison uses the RAW profile — typing the ESCAPED form does NOT resolve (throws)", async () => {
      const { prompt, logger } = makePromptAndLogger();
      const escapedProfile = escapeTerminalControls(RAW_PROFILE);
      // The user types the visually escaped form instead of the raw bytes.
      vi.spyOn(prompt, "text").mockResolvedValue(escapedProfile);
      // confirm returns true: if impl falls through to confirm, it resolves
      // without throwing, thrown is undefined → toBeInstanceOf(M3LError)
      // fails in RED, discriminating the path correctly.
      vi.spyOn(prompt, "confirm").mockResolvedValue(true);

      let thrown: unknown;
      try {
        await confirmDestructive({
          prompt,
          logger,
          description: "nuke controlled cluster",
          yes: false,
          code: "ERR_CONTROL_MISMATCH",
          target: TARGET_WITH_CONTROL,
          isSensitiveTarget: alwaysSensitive,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LError);
      expect((thrown as M3LError).code).toBe("ERR_CONTROL_MISMATCH");
    });
  });
});

// ---------------------------------------------------------------------------
// sensitiveTargets — direct unit tests
// ---------------------------------------------------------------------------

describe("sensitiveTargets", () => {
  const target: M3LDestructiveTarget = {
    profile: "prod",
    region: "us-east-1",
    accountId: "111122223333",
  };

  const targetNoAccount: M3LDestructiveTarget = {
    profile: "staging",
    region: "eu-west-1",
  };

  test("matches when the target profile is in the profiles list", () => {
    const predicate = sensitiveTargets({
      profiles: ["prod", "prod-secondary"],
    });
    expect(predicate(target)).toBe(true);
  });

  test("matches when the target region is in the regions list", () => {
    const predicate = sensitiveTargets({ regions: ["us-east-1"] });
    expect(predicate(target)).toBe(true);
  });

  test("matches when the target accountId is in the accountIds list", () => {
    const predicate = sensitiveTargets({ accountIds: ["111122223333"] });
    expect(predicate(target)).toBe(true);
  });

  test("OR semantics: matches when ANY criterion matches (profile hit, region miss)", () => {
    const predicate = sensitiveTargets({
      profiles: ["prod"],
      regions: ["ap-southeast-1"],
    });
    expect(predicate(target)).toBe(true);
  });

  test("OR semantics: matches when ANY criterion matches (profile miss, region hit)", () => {
    const predicate = sensitiveTargets({
      profiles: ["not-prod"],
      regions: ["us-east-1"],
    });
    expect(predicate(target)).toBe(true);
  });

  test("no match when target fields appear in none of the lists", () => {
    const predicate = sensitiveTargets({
      profiles: ["dev"],
      regions: ["eu-central-1"],
      accountIds: ["999988887777"],
    });
    expect(predicate(target)).toBe(false);
  });

  test("empty spec (all fields omitted) matches nothing", () => {
    const predicate = sensitiveTargets({});
    expect(predicate(target)).toBe(false);
  });

  test("empty spec (no argument fields) matches nothing — explicit empty arrays", () => {
    const predicate = sensitiveTargets({
      profiles: [],
      regions: [],
      accountIds: [],
    });
    expect(predicate(target)).toBe(false);
  });

  test("target with omitted accountId is NOT matched by an accountIds spec", () => {
    // targetNoAccount has no accountId; the predicate must not throw and must return false.
    const predicate = sensitiveTargets({ accountIds: ["111122223333"] });
    expect(predicate(targetNoAccount)).toBe(false);
  });

  test("sensitiveTargets returns a callable predicate (integration: works with confirmDestructive)", async () => {
    const { prompt, logger } = makePromptAndLogger();
    vi.spyOn(prompt, "text").mockResolvedValue("prod");

    // "prod" profile is in the sensitive list → escalates.
    await expect(
      confirmDestructive({
        prompt,
        logger,
        description: "deploy to prod",
        yes: false,
        code: "ERR_ABORTED",
        target: PROD_TARGET,
        isSensitiveTarget: sensitiveTargets({ profiles: ["prod"] }),
      }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// matchesSensitiveList three-way rule: absent → no match, array → membership,
// present-but-not-array → fail-closed match. This fix landed with zero test
// coverage (no existing assertion changed outcome), and the fail-closed
// direction — returning `true` for a malformed own field rather than `false`
// — was a deliberate maintainer choice: an uninterpretable grading spec is an
// unprovable state, so it must grade sensitive rather than silently pass.
// ---------------------------------------------------------------------------
describe("sensitiveTargets — malformed spec field fails closed (matchesSensitiveList)", () => {
  test("profiles as an array: matches a listed profile", () => {
    const predicate = sensitiveTargets({ profiles: ["prod"] });
    expect(predicate({ profile: "prod" })).toBe(true);
  });

  test("profiles as an array: does not match an unlisted profile", () => {
    const predicate = sensitiveTargets({ profiles: ["prod"] });
    expect(predicate({ profile: "sandbox" })).toBe(false);
  });

  test("profiles as a malformed (non-array) string: matches the exact value", () => {
    // Deliberately models a JavaScript caller that TypeScript would reject
    // (M3LSensitiveTargetSpec.profiles is `readonly string[] | undefined`) —
    // exactly the caller this fail-closed guard exists for.
    const predicate = sensitiveTargets({
      profiles: "prod" as unknown as readonly string[],
    });
    expect(predicate({ profile: "prod" })).toBe(true);
  });

  test("profiles as a malformed (non-array) string still matches a NON-matching profile (fail-closed, not substring)", () => {
    // The sharpest case: a malformed own `profiles` field grades even a
    // target whose profile is nowhere near "prod" as sensitive, because the
    // spec is uninterpretable and an uninterpretable grading spec is an
    // unprovable state — this is the fail-closed direction, not a substring
    // or exact-match test.
    const predicate = sensitiveTargets({
      profiles: "prod" as unknown as readonly string[],
    });
    expect(predicate({ profile: "sandbox" })).toBe(true);
  });

  test("profiles as a malformed (non-array) number: fails closed", () => {
    const predicate = sensitiveTargets({
      profiles: 42 as unknown as readonly string[],
    });
    expect(predicate({ profile: "sandbox" })).toBe(true);
  });

  test("profiles as a malformed (non-array) object: fails closed", () => {
    const predicate = sensitiveTargets({
      profiles: {} as unknown as readonly string[],
    });
    expect(predicate({ profile: "sandbox" })).toBe(true);
  });

  test("regions spec present but target has no region: never matches, even when regions is malformed", () => {
    const predicate = sensitiveTargets({ regions: ["x"] });
    expect(predicate({ profile: "sandbox" })).toBe(false);
  });

  test("empty spec: never matches", () => {
    const predicate = sensitiveTargets({});
    expect(predicate({ profile: "prod" })).toBe(false);
  });

  test("regions as a malformed (non-array) string: fails closed for a present, non-matching region", () => {
    const predicate = sensitiveTargets({
      regions: "us-east-1" as unknown as readonly string[],
    });
    expect(predicate({ profile: "prod", region: "eu-west-1" })).toBe(true);
  });

  test("accountIds as a malformed (non-array) number: fails closed for a present, non-matching accountId", () => {
    const predicate = sensitiveTargets({
      accountIds: 42 as unknown as readonly string[],
    });
    expect(
      predicate({
        profile: "prod",
        region: "us-east-1",
        accountId: "999988887777",
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Type-level contract
// ---------------------------------------------------------------------------

describe("type-level contract", () => {
  test("existing call site without target fields still satisfies M3LConfirmDestructiveOptions (all three new fields are optional)", () => {
    expectTypeOf<{
      prompt: M3LPrompt;
      logger: M3LLogger;
      description: string;
      yes: boolean;
      code: string;
    }>().toExtend<M3LConfirmDestructiveOptions>();
  });

  test("M3LDestructiveTargetPredicate is (target: M3LDestructiveTarget) => boolean", () => {
    expectTypeOf<M3LDestructiveTargetPredicate>().toEqualTypeOf<
      (target: M3LDestructiveTarget) => boolean
    >();
  });

  test("sensitiveTargets returns an M3LDestructiveTargetPredicate", () => {
    expectTypeOf(
      sensitiveTargets,
    ).returns.toEqualTypeOf<M3LDestructiveTargetPredicate>();
  });

  test("sensitiveTargets accepts an M3LSensitiveTargetSpec argument", () => {
    expectTypeOf(sensitiveTargets)
      .parameter(0)
      .toExtend<M3LSensitiveTargetSpec>();
  });

  test("M3LDestructiveTarget requires profile as a string field (region and accountId are optional)", () => {
    // A positive structural assertion: M3LDestructiveTarget must be a subtype of
    // { profile: string }, meaning profile is required.
    // region and accountId are optional per the current interface — callers that
    // cannot supply a region still benefit from profile- and account-based grading.
    // (@ts-expect-error negative assertions are not used here because in RED
    // the type resolves to `any`, making every assignment succeed and the
    // directive "unused" → TS2578. The positive check below is self-consistent
    // in both RED and GREEN and correctly specifies the contract.)
    expectTypeOf<M3LDestructiveTarget>().toExtend<{
      readonly profile: string;
    }>();
  });

  test("M3LDestructiveTarget accountId is optional (object without accountId is assignable)", () => {
    expectTypeOf({
      profile: "prod",
      region: "us-east-1",
    }).toExtend<M3LDestructiveTarget>();
  });

  test("confirmDestructive still returns Promise<void> with target-graded options", () => {
    expectTypeOf(confirmDestructive).returns.toEqualTypeOf<Promise<void>>();
  });
});

// ---------------------------------------------------------------------------
// Decision 1 — region becomes optional on M3LDestructiveTarget
// ---------------------------------------------------------------------------
//
// Contract change: M3LDestructiveTarget.region changes from `string` to
// `string | undefined` (optional). M3LScript resolves aws.region as
// M3LAWSRegion | undefined, so requiring region would silently disable
// target-graded confirmation for scripts that leave aws.region optional.
//
// RED signals:
// - pnpm typecheck: REGION_LESS_TARGET declaration, expectTypeOf positive test →
//   TS2741 (region required) and TS2344 (not assignable), respectively.
// - Runtime: tests that pass through buildTargetBanner with region-less target
//   throw TypeError (escapeTerminalControls(undefined) calls undefined.replace).
//   Tests that exercise only the sensitiveTargets predicate pass at runtime.

describe("Decision 1 — region becomes optional on M3LDestructiveTarget", () => {
  // region is now optional on M3LDestructiveTarget — this assignment compiles
  // without a cast now that the interface ships `region?: string`.
  const REGION_LESS_TARGET: M3LDestructiveTarget = {
    profile: "staging",
    // region intentionally omitted — this is the contract under test
  };

  // -------------------------------------------------------------------------
  // sensitiveTargets matching semantics with optional region
  // -------------------------------------------------------------------------

  describe("sensitiveTargets — matching semantics with region-less target", () => {
    test("regions spec does NOT match a target whose region is omitted — mirrors the accountIds+omitted-accountId behaviour", () => {
      // Runtime: passes even in RED — includes(undefined) returns false on string[]
      // Typecheck: fails in RED — region is still required on M3LDestructiveTarget
      const predicate = sensitiveTargets({
        regions: ["us-east-1", "eu-west-1"],
      });
      expect(predicate(REGION_LESS_TARGET)).toBe(false);
    });

    test("profiles spec still matches a region-less target — profile matching is region-agnostic", () => {
      // Runtime: passes in RED — profile comparison does not touch region
      // Typecheck: fails in RED (same REGION_LESS_TARGET diagnostic)
      const predicate = sensitiveTargets({ profiles: ["staging"] });
      expect(predicate(REGION_LESS_TARGET)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Escalated echo with region-less sensitive target
  // -------------------------------------------------------------------------

  describe("escalated echo with region-less sensitive target", () => {
    test("region-less sensitive target enters typed-echo path and resolves on profile match", async () => {
      // Runtime RED: TypeError in buildTargetBanner (escapeTerminalControls(undefined))
      // Runtime GREEN: resolves after profile "staging" matches
      // Typecheck RED: TS2741 on REGION_LESS_TARGET
      const { prompt, logger } = makePromptAndLogger();
      const text = vi.spyOn(prompt, "text").mockResolvedValue("staging");
      // confirm returns false: if unimplemented path falls to confirm, it would throw;
      // in GREEN the correct path calls text (returns "staging"), matches, resolves.
      vi.spyOn(prompt, "confirm").mockResolvedValue(false);

      await expect(
        confirmDestructive({
          prompt,
          logger,
          description: "delete staging cluster",
          yes: false,
          code: "ERR_D1_ABORTED",
          target: REGION_LESS_TARGET,
          isSensitiveTarget: sensitiveTargets({ profiles: ["staging"] }),
        }),
      ).resolves.toBeUndefined();

      expect(text).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Banner degradation
  // -------------------------------------------------------------------------

  describe("banner degrades gracefully — region= fragment present iff region is supplied", () => {
    test("banner omits region= fragment when region is absent — only profile= rendered", async () => {
      // Runtime RED: TypeError from escapeTerminalControls(undefined) in buildTargetBanner
      // Runtime GREEN: banner contains "profile=staging" and no "region=" substring
      // Typecheck RED: TS2741 on REGION_LESS_TARGET
      const { prompt, logger } = makePromptAndLogger();
      const text = vi.spyOn(prompt, "text").mockResolvedValue("staging");
      vi.spyOn(prompt, "confirm").mockResolvedValue(false);

      await confirmDestructive({
        prompt,
        logger,
        description: "delete staging cluster",
        yes: false,
        code: "ERR_D1_ABORTED",
        target: REGION_LESS_TARGET,
        isSensitiveTarget: alwaysSensitive,
      });

      expect(text).toHaveBeenCalledTimes(1);
      const msg = text.mock.calls[0]?.[0] as string;
      expect(msg).toContain("profile=staging");
      expect(msg).not.toContain("region=");
    });

    test("banner renders both profile= and region= when region is present", async () => {
      // This test passes in RED at runtime (region is present; existing path unchanged)
      // Typecheck: passes in RED (the object literal satisfies the current type)
      const { prompt, logger } = makePromptAndLogger();
      const text = vi.spyOn(prompt, "text").mockResolvedValue("staging");
      vi.spyOn(prompt, "confirm").mockResolvedValue(false);

      await confirmDestructive({
        prompt,
        logger,
        description: "delete staging cluster",
        yes: false,
        code: "ERR_D1_ABORTED",
        target: { profile: "staging", region: "eu-west-1" },
        isSensitiveTarget: alwaysSensitive,
      });

      const msg = text.mock.calls[0]?.[0] as string;
      expect(msg).toContain("profile=staging");
      expect(msg).toContain("region=eu-west-1");
    });
  });

  // -------------------------------------------------------------------------
  // State-3 bypass warning with region-less target
  // -------------------------------------------------------------------------

  describe("state-3 bypass warning with region-less target", () => {
    test("bypass warning omits region= fragment when region is absent", async () => {
      // Runtime RED: TypeError from escapeTerminalControls(undefined) in buildTargetBanner
      // Runtime GREEN: warning contains "staging" but no "region=" substring
      // Typecheck RED: TS2741 on REGION_LESS_TARGET
      const { prompt, logger } = makePromptAndLogger();
      const warning = vi.spyOn(logger, "warning");

      await confirmDestructive({
        prompt,
        logger,
        description: "nuke staging",
        yes: true,
        yesSensitive: true,
        code: "ERR_D1_ABORTED",
        target: REGION_LESS_TARGET,
        isSensitiveTarget: alwaysSensitive,
      });

      expect(warning).toHaveBeenCalledTimes(1);
      const msg = warning.mock.calls[0]?.[0] as string;
      expect(msg).toContain("staging");
      expect(msg).not.toContain("region=");
    });
  });

  // -------------------------------------------------------------------------
  // Type-level contract for optional region
  // -------------------------------------------------------------------------

  describe("type-level contract — region optional, profile required", () => {
    test("{ profile } alone satisfies M3LDestructiveTarget — region is optional in the new contract", () => {
      // In RED: typecheck fails — M3LDestructiveTarget.region is still required,
      // so { profile: string } is not assignable to M3LDestructiveTarget (TS2344).
      // In GREEN: region is optional → passes.
      expectTypeOf<{ profile: string }>().toExtend<M3LDestructiveTarget>();
    });

    test("object without profile does not satisfy M3LDestructiveTarget — profile stays required in both contracts", () => {
      // @ts-expect-error -- { region?: string } missing profile must never satisfy M3LDestructiveTarget; valid in RED and GREEN
      const _invalid: M3LDestructiveTarget = { region: "us-east-1" };
      // Runtime assertion just to make the test non-empty; the contract check is the @ts-expect-error above.
      expect(_invalid).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Decision 2 — a blank echo token FAILS CLOSED
// ---------------------------------------------------------------------------
//
// Contract change: in runEscalatedEcho, a blank or whitespace-only profile
// must never match any input. The current comparison `input.trim() !== target.profile`
// lets empty input confirm a blank profile ("".trim() === "" → resolves).
// Fix direction: add a guard that rejects a blank token BEFORE the comparison,
// so the comparison guard is still run after prompt.text — no short-circuit.
//
// RED signals (runtime):
// - All tests with profile="" fail: function resolves (no throw) instead of throwing.
// - Tests with profile="   " already pass (trim never equals "   ").
// - "prompt.text IS called" test passes in both RED and GREEN.

describe("Decision 2 — blank echo token fails closed", () => {
  const DESCRIPTION = "delete all prod data";
  const CODE = "ERR_BLANK_PROFILE";

  // Helper to invoke confirmDestructive on a sensitive target with a given profile.
  // Callers mock prompt.text to control what the simulated user types.
  async function attemptWithBlankProfile(
    profile: string,
    prompt: M3LPrompt,
    logger: M3LLogger,
  ): Promise<void> {
    return confirmDestructive({
      prompt,
      logger,
      description: DESCRIPTION,
      yes: false,
      code: CODE,
      target: { profile, region: "us-east-1" },
      isSensitiveTarget: alwaysSensitive,
    });
  }

  // -------------------------------------------------------------------------
  // Blank profile — "" (the specific hole)
  // -------------------------------------------------------------------------

  describe('blank profile ""', () => {
    test('empty input "" cannot satisfy a blank profile — throws aborted error', async () => {
      // RED: "".trim() === "" → resolves (bug) → rejects assertion fails
      // GREEN: blank-token guard fires → throws M3LError
      const { prompt, logger } = makePromptAndLogger();
      vi.spyOn(prompt, "text").mockResolvedValue("");
      // confirm returns true: if impl falls through to confirm-path and resolves,
      // the rejects assertion fails, proving the bug is present.
      vi.spyOn(prompt, "confirm").mockResolvedValue(true);

      let thrown: unknown;
      try {
        await attemptWithBlankProfile("", prompt, logger);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LError);
      expect((thrown as M3LError).message).toBe(`aborted: ${DESCRIPTION}`);
      expect((thrown as M3LError).code).toBe(CODE);
    });

    test('whitespace input "   " cannot satisfy a blank profile — throws aborted error', async () => {
      // RED: "   ".trim() === "" === "" → resolves (bug)
      // GREEN: blank-token guard fires → throws M3LError
      const { prompt, logger } = makePromptAndLogger();
      vi.spyOn(prompt, "text").mockResolvedValue("   ");
      vi.spyOn(prompt, "confirm").mockResolvedValue(true);

      let thrown: unknown;
      try {
        await attemptWithBlankProfile("", prompt, logger);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LError);
      expect((thrown as M3LError).message).toBe(`aborted: ${DESCRIPTION}`);
      expect((thrown as M3LError).code).toBe(CODE);
    });

    test("input equal to the raw blank profile cannot confirm — the specific hole being closed", async () => {
      // This test encodes the exact hole: raw blank profile + equal raw input resolves today.
      // The fix: a blank token makes confirmation impossible regardless of what input was typed.
      // RED: "".trim() === "" → resolves (bug). GREEN: throws.
      const { prompt, logger } = makePromptAndLogger();
      const RAW_BLANK = "";
      vi.spyOn(prompt, "text").mockResolvedValue(RAW_BLANK);
      vi.spyOn(prompt, "confirm").mockResolvedValue(true);

      await expect(
        attemptWithBlankProfile(RAW_BLANK, prompt, logger),
      ).rejects.toBeInstanceOf(M3LError);
    });

    test("thrown message is exactly 'aborted: <raw description>' — no target fields leak in", async () => {
      // RED: resolves (no throw) → rejects assertion fails, proving the hole
      const { prompt, logger } = makePromptAndLogger();
      vi.spyOn(prompt, "text").mockResolvedValue("anything");
      vi.spyOn(prompt, "confirm").mockResolvedValue(true);

      await expect(
        attemptWithBlankProfile("", prompt, logger),
      ).rejects.toMatchObject({
        message: `aborted: ${DESCRIPTION}`,
        code: CODE,
      });
    });

    test("prompt.text IS still called — fix must be a comparison guard, not an early throw that skips the prompt", async () => {
      // This test passes in BOTH RED and GREEN: prompt.text is called before the
      // (missing in RED, present in GREEN) blank-token guard. A fix that short-circuits
      // before prompt.text would make this test fail in GREEN, surfacing the wrong approach.
      const { prompt, logger } = makePromptAndLogger();
      const text = vi.spyOn(prompt, "text").mockResolvedValue("");
      vi.spyOn(prompt, "confirm").mockResolvedValue(true);

      try {
        await attemptWithBlankProfile("", prompt, logger);
      } catch {
        // Either the bug (resolves in RED) or the fix (throws in GREEN) — we only verify text was called.
      }

      expect(text).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Whitespace-only profile — "   " (three spaces)
  // -------------------------------------------------------------------------

  describe('whitespace-only profile "   "', () => {
    const WS_PROFILE = "   ";

    test('empty input "" cannot satisfy a whitespace-only profile — throws aborted error', async () => {
      // Passes in RED already: "".trim() === "" !== "   " → throws (existing comparison catches it)
      // GREEN: blank-token guard also catches it (belt-and-suspenders)
      const { prompt, logger } = makePromptAndLogger();
      vi.spyOn(prompt, "text").mockResolvedValue("");
      vi.spyOn(prompt, "confirm").mockResolvedValue(true);

      let thrown: unknown;
      try {
        await attemptWithBlankProfile(WS_PROFILE, prompt, logger);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LError);
      expect((thrown as M3LError).message).toBe(`aborted: ${DESCRIPTION}`);
    });

    test('input equal to the raw whitespace-only profile "   " cannot confirm — no input satisfies a blank token', async () => {
      // Passes in RED: "   ".trim() === "" !== "   " → throws (existing comparison catches it)
      // GREEN: blank-token guard fires before comparison
      const { prompt, logger } = makePromptAndLogger();
      vi.spyOn(prompt, "text").mockResolvedValue(WS_PROFILE);
      vi.spyOn(prompt, "confirm").mockResolvedValue(true);

      await expect(
        attemptWithBlankProfile(WS_PROFILE, prompt, logger),
      ).rejects.toBeInstanceOf(M3LError);
    });

    test("prompt.text IS called for whitespace-only profile — fix must not short-circuit before prompting", async () => {
      // Passes in RED and GREEN: text is called in the existing code path too.
      const { prompt, logger } = makePromptAndLogger();
      const text = vi.spyOn(prompt, "text").mockResolvedValue(WS_PROFILE);
      vi.spyOn(prompt, "confirm").mockResolvedValue(true);

      try {
        await attemptWithBlankProfile(WS_PROFILE, prompt, logger);
      } catch {
        // We only care that text was called, not whether the function threw or resolved.
      }

      expect(text).toHaveBeenCalledTimes(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Finding 1 — isSensitiveTarget truthiness guard (fail-OPEN, ADR-0048)
//
// The contract: the gate must escalate (call prompt.text, not bypass) whenever
// isSensitiveTarget returns ANY truthy value, not only strict `true`.  The
// current implementation uses `!== true`, so a predicate returning `1`, `"yes"`,
// `{}`, or `[]` falls into the ungraded path — a security regression.
//
// RED: truthy non-true tests FAIL (bypass fires, text never called).
// GREEN: truthiness check fires, text IS called.
// ---------------------------------------------------------------------------

describe("Finding 1 — isSensitiveTarget truthiness guard: truthy non-true return escalates", () => {
  // -------------------------------------------------------------------------
  // A: truthy non-`true` returns → must escalate (RED — will fail)
  // -------------------------------------------------------------------------
  test.each([
    ["1 (number truthy)", 1],
    ['"yes" (string truthy)', "yes"],
    ["{} (object truthy)", {}],
    ["[] (array truthy)", []],
  ])(
    "isSensitiveTarget returning %s with yes:true escalates instead of bypassing",
    async (_label, value) => {
      // Cast simulates an untyped JS consumer whose predicate returns a truthy
      // non-boolean value.  The type is (target) => boolean; the cast is the
      // narrowest possible and defends exactly the runtime pattern that triggers
      // the fail-OPEN: an isSensitiveTarget that returns 1/"yes"/{}/[] from JS.
      const isSensitiveTarget = (() =>
        value) as unknown as M3LDestructiveTargetPredicate;
      const { prompt, logger } = makePromptAndLogger();
      // Return the profile so the escalated echo resolves successfully.
      const text = vi
        .spyOn(prompt, "text")
        .mockResolvedValue(PROD_TARGET.profile);
      const confirm = vi.spyOn(prompt, "confirm");
      const warning = vi.spyOn(logger, "warning");

      // RED: isSensitiveTarget() !== true → ungraded path → yes:true bypasses
      //      via warning → text never called.  This assertion fails in RED.
      // GREEN: truthiness check → escalates → text IS called.
      await expect(
        confirmDestructive({
          prompt,
          logger,
          description: "nuke prod cluster",
          yes: true,
          code: "ERR_ABORTED",
          target: PROD_TARGET,
          isSensitiveTarget,
        }),
      ).resolves.toBeUndefined();

      expect(text).toHaveBeenCalled();
      // No bypass warning must be emitted on the escalated path.
      expect(warning).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
    },
  );

  // -------------------------------------------------------------------------
  // B: falsy returns → ungraded path (should already pass in RED)
  //    Only a strictly falsy return means "not sensitive"; the gate DOES
  //    correctly route these to the ungraded path even before the fix.
  // -------------------------------------------------------------------------
  test.each([
    ["false", false],
    ["0 (number)", 0],
    ['""  (empty string)', ""],
    ["undefined", undefined],
    ["null", null],
    ["NaN", NaN],
  ])(
    "isSensitiveTarget returning %s stays on the ungraded path (confirm IS called)",
    async (_label, value) => {
      // Same cast rationale: simulates JS consumer returning a falsy non-boolean.
      const isSensitiveTarget = (() =>
        value) as unknown as M3LDestructiveTargetPredicate;
      const { prompt, logger } = makePromptAndLogger();
      const confirm = vi.spyOn(prompt, "confirm").mockResolvedValue(true);
      const text = vi.spyOn(prompt, "text");

      await expect(
        confirmDestructive({
          prompt,
          logger,
          description: "nuke prod cluster",
          yes: false,
          code: "ERR_ABORTED",
          target: PROD_TARGET,
          isSensitiveTarget,
        }),
      ).resolves.toBeUndefined();

      expect(confirm).toHaveBeenCalledTimes(1);
      expect(text).not.toHaveBeenCalled();
    },
  );

  // -------------------------------------------------------------------------
  // C: yesSensitive strict guard — `=== true` stays strict on the bypass side
  //    A truthy non-`true` yesSensitive must NOT bypass; the escalated echo
  //    must still run.  This direction uses a normally-true predicate so the
  //    gate reaches the yesSensitive check.  Should PASS in RED (the === true
  //    comparison for yesSensitive is already correct).
  // -------------------------------------------------------------------------
  test.each([
    ["1 (number truthy)", 1],
    ['"yes" (string truthy)', "yes"],
  ])(
    "yesSensitive set to truthy non-true %s does NOT bypass: escalated echo still runs",
    async (_label, value) => {
      const { prompt, logger } = makePromptAndLogger();
      const text = vi
        .spyOn(prompt, "text")
        .mockResolvedValue(PROD_TARGET.profile);
      const confirm = vi.spyOn(prompt, "confirm");
      const warning = vi.spyOn(logger, "warning");

      await expect(
        confirmDestructive({
          prompt,
          logger,
          description: "nuke prod cluster",
          yes: true,
          // Simulates a JS caller passing a truthy non-boolean.  yesSensitive is
          // typed boolean so we need the narrowest cast.
          yesSensitive: value as unknown as boolean,
          code: "ERR_ABORTED",
          target: PROD_TARGET,
          isSensitiveTarget: alwaysSensitive,
        }),
      ).resolves.toBeUndefined();

      expect(text).toHaveBeenCalled();
      expect(warning).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
    },
  );
});
