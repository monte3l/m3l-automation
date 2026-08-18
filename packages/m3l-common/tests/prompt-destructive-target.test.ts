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
    }>().toMatchTypeOf<M3LConfirmDestructiveOptions>();
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
      .toMatchTypeOf<M3LSensitiveTargetSpec>();
  });

  test("M3LDestructiveTarget requires both profile and region as string fields", () => {
    // A positive structural assertion: M3LDestructiveTarget must be a subtype of
    // { profile: string; region: string }, meaning both fields are required.
    // (@ts-expect-error negative assertions are not used here because in RED
    // the type resolves to `any`, making every assignment succeed and the
    // directive "unused" → TS2578. The positive check below is self-consistent
    // in both RED and GREEN and correctly specifies the contract.)
    expectTypeOf<M3LDestructiveTarget>().toMatchTypeOf<{
      readonly profile: string;
      readonly region: string;
    }>();
  });

  test("M3LDestructiveTarget accountId is optional (object without accountId is assignable)", () => {
    expectTypeOf({
      profile: "prod",
      region: "us-east-1",
    }).toMatchTypeOf<M3LDestructiveTarget>();
  });

  test("confirmDestructive still returns Promise<void> with target-graded options", () => {
    expectTypeOf(confirmDestructive).returns.toEqualTypeOf<Promise<void>>();
  });
});
