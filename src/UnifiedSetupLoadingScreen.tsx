import React, { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, CheckCircle2, ExternalLink, Link2, RefreshCw } from "lucide-react";

// shadcn/ui primitives (swap for your DS if needed)
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

/**
 * Unified first-time setup loading screen (Ascension One)
 *
 * Includes:
 * - Provisioning (3s) + Subscription check (12s)
 * - Inline errors for step 1 and step 2 (pause flow, try again; skip appears on 2nd error and exits to Home)
 * - Connect CTA
 * - Connecting step with substeps + progress
 * - Error overlay with retry + skip
 * - Fast-load (20s) and normal (90s) paths
 * - Full-screen success interstitial + auto-redirect to Home
 * - Brief flash color (#E6FFFB) when a step transitions to done
 * - Simulated pop-up overlay when window.open is blocked
 */

// ---------------------------
// Types
// ---------------------------

type Status = "idle" | "active" | "done" | "error";

type SetupPhase = "boot" | "needs_link" | "linking" | "complete";

type StepId = "provision" | "check" | "connect" | "sync";

type Step = {
  id: StepId;
  label: string;
  description?: string;
  status: Status;
  substeps?: { id: string; label: string; status: Status }[];
};

type SubStepId = "access" | "visits" | "results" | "finalize";

type Screen = "setup" | "success" | "home";

type SuccessVariant = "success" | "limited" | "uptodate";

type PopupStage = "ascension" | "cerner" | "athena";

type StepRowProps = {
  step: Step;
  phase: SetupPhase;
  linkPercent: number;
  onConnect: () => void;
  onSkipLinking: () => void;
  onRetryProvision: () => void;
  onSkipProvision: () => void;
  onRetryCheck: () => void;
  onSkipCheck: () => void;
  connectBusy: boolean;
  isRetrying: boolean;
  flashDone: boolean;
  provisionAttempts: number;
  checkAttempts: number;
};

// ---------------------------
// Utils
// ---------------------------

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

// ---------------------------
// Mock backend
// ---------------------------

async function mockPehrCall(simulateNoLink: boolean) {
  // Simulate 600-1800ms
  await sleep(600 + Math.random() * 1200);
  return {
    ehrLinkingRequired: simulateNoLink ? false : true,
  };
}

async function mockEhrPopupFlow() {
  // Simulate pop-up flow (2-8s)
  await sleep(2000 + Math.random() * 6000);
}

const MOCK_SYNC_MS = 90_000;
const FAST_SYNC_MS = 20_000;

async function mockServerSyncWait(durationMs: number) {
  await sleep(durationMs);
}

// ---------------------------
// Progress pacing + substeps mapping
// ---------------------------

function progressFromElapsed(elapsedMs: number, capMs: number) {
  const e = clamp(elapsedMs, 0, capMs);

  const scale = capMs / MOCK_SYNC_MS;
  const t1 = Math.max(250, Math.round(10_000 * scale));
  const t2 = Math.max(t1 + 250, Math.round(70_000 * scale));

  if (e <= t1) return Math.floor((e / t1) * 25);
  if (e <= t2) return Math.floor(25 + ((e - t1) / (t2 - t1)) * 65);

  const denom = Math.max(1, capMs - t2);
  return Math.floor(90 + ((e - t2) / denom) * 7);
}

const SUBSTEP_THRESHOLDS = {
  access: 22,
  visits: 55,
  results: 78,
  finalize: 92,
} as const;

function deriveSubsteps(pct: number, syncDone: boolean) {
  const order: SubStepId[] = ["access", "visits", "results", "finalize"];

  if (syncDone) return order.map((id) => ({ id, status: "done" as Status }));

  const done = new Set<SubStepId>();
  if (pct >= SUBSTEP_THRESHOLDS.access) done.add("access");
  if (pct >= SUBSTEP_THRESHOLDS.visits) done.add("visits");
  if (pct >= SUBSTEP_THRESHOLDS.results) done.add("results");

  const inFinalStretch = pct >= SUBSTEP_THRESHOLDS.finalize;

  let active: SubStepId = "access";
  if (!done.has("access")) active = "access";
  else if (!done.has("visits")) active = "visits";
  else if (!done.has("results")) active = "results";
  else active = "finalize";

  if (inFinalStretch) active = "finalize";

  return order.map((id) => {
    if (id === "finalize") {
      return { id, status: inFinalStretch ? ("active" as Status) : ("idle" as Status) };
    }
    if (done.has(id)) return { id, status: "done" as Status };
    if (id === active) return { id, status: "active" as Status };
    return { id, status: "idle" as Status };
  });
}

// ---------------------------
// Initial step model
// ---------------------------

const initialSteps = (): Step[] => [
  {
    id: "provision",
    label: "Setting up your profile",
    description: "Getting your account ready for records",
    status: "active",
  },
  {
    id: "check",
    label: "Checking for records",
    description: "Looking for records to connect",
    status: "idle",
  },
  {
    id: "connect",
    label: "Connect to Ascension records",
    description: "Link your health system",
    status: "idle",
  },
  {
    id: "sync",
    label: "Connecting your records",
    description: "Getting your records ready (up to 90 seconds)",
    status: "idle",
    substeps: [
      { id: "access", label: "Finding your records", status: "idle" },
      { id: "visits", label: "Matching records to you", status: "idle" },
      { id: "results", label: "Saving records to your account", status: "idle" },
      { id: "finalize", label: "Getting ready to load your records", status: "idle" },
    ],
  },
];

// ---------------------------
// Main component
// ---------------------------

export default function UnifiedSetupLoadingScreen() {
  const [phase, setPhase] = useState<SetupPhase>("boot");

  // Simulated redirect
  const [screen, setScreen] = useState<Screen>("setup");
  const [isRedirecting, setIsRedirecting] = useState(false);
  const [isExitingToHome, setIsExitingToHome] = useState(false);
  const hasScheduledRedirectRef = useRef(false);

  // Dev toggles
  const [simulateNoLink, setSimulateNoLink] = useState(false);
  const [simulateLinkError, setSimulateLinkError] = useState(false);
  const [simulateFastLoad, setSimulateFastLoad] = useState(false);
  const [simulateProvisionError, setSimulateProvisionError] = useState(false);
  const [simulateCheckError, setSimulateCheckError] = useState(false);
  const [runKey, setRunKey] = useState(0);

  // Simulated pop-up overlay (used when the browser blocks window.open)
  const [showPopupOverlay, setShowPopupOverlay] = useState(false);
  const [popupStage, setPopupStage] = useState<PopupStage>("ascension");

  // Current sync duration for progress + mock wait
  const [syncDurationMs, setSyncDurationMs] = useState<number>(MOCK_SYNC_MS);

  // Retry micro-state (used after errors)
  const [isRetrying, setIsRetrying] = useState(false);

  // Error state per step
  const [provisionErrored, setProvisionErrored] = useState(false);
  const [checkErrored, setCheckErrored] = useState(false);
  const [syncErrored, setSyncErrored] = useState(false);

  // Skip flags
  const [skippedProvision, setSkippedProvision] = useState(false);
  const [skippedCheck, setSkippedCheck] = useState(false);
  const [skippedLinking, setSkippedLinking] = useState(false);

  // Attempts (Skip appears on 2nd error)
  const [provisionAttempts, setProvisionAttempts] = useState(0);
  const [checkAttempts, setCheckAttempts] = useState(0);

  // Linking progress
  const [linkPercent, setLinkPercent] = useState(0);
  const [syncDone, setSyncDone] = useState(false);
  const [connectBusy, setConnectBusy] = useState(false);
  const linkingStartedAt = useRef<number | null>(null);

  const [steps, setSteps] = useState<Step[]>(() => initialSteps());

  // Flash done background briefly
  const [flashDoneMap, setFlashDoneMap] = useState<Record<StepId, boolean>>({
    provision: false,
    check: false,
    connect: false,
    sync: false,
  });
  const prevStatusRef = useRef<Record<StepId, Status>>({
    provision: "active",
    check: "idle",
    connect: "idle",
    sync: "idle",
  });
  const flashTimersRef = useRef<Record<StepId, number | null>>({
    provision: null,
    check: null,
    connect: null,
    sync: null,
  });

  useEffect(() => {
    for (const s of steps) {
      const prev = prevStatusRef.current[s.id];
      if (prev !== "done" && s.status === "done") {
        setFlashDoneMap((m) => ({ ...m, [s.id]: true }));
        const existing = flashTimersRef.current[s.id];
        if (existing) window.clearTimeout(existing);
        flashTimersRef.current[s.id] = window.setTimeout(() => {
          setFlashDoneMap((m) => ({ ...m, [s.id]: false }));
          flashTimersRef.current[s.id] = null;
        }, 900);
      }
      prevStatusRef.current[s.id] = s.status;
    }
  }, [steps]);

  const completedCount = useMemo(() => steps.filter((s) => s.status === "done").length, [steps]);

  // ---------------------------
  // Boot flow helpers
  // ---------------------------

  const bootTokenRef = useRef(0);

  const setStepStatus = (id: StepId, status: Status) => {
    setSteps((p) => p.map((s) => (s.id === id ? { ...s, status } : s)));
  };

  async function runProvision(token: number) {
    setProvisionErrored(false);
    setStepStatus("provision", "active");
    await sleep(3000);
    if (bootTokenRef.current !== token) return { ok: false, aborted: true };

    if (simulateProvisionError) {
      setProvisionAttempts((n) => n + 1);
      setProvisionErrored(true);
      setStepStatus("provision", "error");
      return { ok: false, aborted: false };
    }

    setStepStatus("provision", "done");
    return { ok: true, aborted: false };
  }

  async function runCheck(token: number) {
    setCheckErrored(false);
    setStepStatus("check", "active");
    await sleep(12_000);
    if (bootTokenRef.current !== token) return { ok: false, aborted: true };

    if (simulateCheckError) {
      setCheckAttempts((n) => n + 1);
      setCheckErrored(true);
      setStepStatus("check", "error");
      return { ok: false, aborted: false };
    }

    setStepStatus("check", "done");
    return { ok: true, aborted: false };
  }

  // ---------------------------
  // Boot flow
  // ---------------------------

  useEffect(() => {
    let cancelled = false;

    async function run() {
      const token = bootTokenRef.current + 1;
      bootTokenRef.current = token;

      // Reset state
      setPhase("boot");
      setScreen("setup");
      setIsRedirecting(false);
      setIsExitingToHome(false);
      hasScheduledRedirectRef.current = false;

      setShowPopupOverlay(false);
      setPopupStage("ascension");

      setSyncDurationMs(simulateFastLoad ? FAST_SYNC_MS : MOCK_SYNC_MS);
      setLinkPercent(0);
      setSyncDone(false);
      linkingStartedAt.current = null;

      setProvisionErrored(false);
      setCheckErrored(false);
      setSyncErrored(false);
      setSkippedProvision(false);
      setSkippedCheck(false);
      setSkippedLinking(false);
      setIsRetrying(false);
      setProvisionAttempts(0);
      setCheckAttempts(0);

      setSteps(initialSteps());

      // Step 1
      const p1 = await runProvision(token);
      if (cancelled || p1.aborted) return;
      if (!p1.ok) return; // pause for user action

      // small stagger
      await sleep(400);
      if (cancelled || bootTokenRef.current !== token) return;

      // Step 2
      const p2 = await runCheck(token);
      if (cancelled || p2.aborted) return;
      if (!p2.ok) return; // pause for user action

      // After check succeeds, decide next path
      const pehr = await mockPehrCall(simulateNoLink);
      if (cancelled || bootTokenRef.current !== token) return;

      if (pehr.ehrLinkingRequired) {
        setPhase("needs_link");
        setStepStatus("connect", "active");
      } else {
        // No records to connect right now: finish steps without running sync progress
        setStepStatus("connect", "active");
        await sleep(900);
        if (cancelled || bootTokenRef.current !== token) return;
        setStepStatus("connect", "done");

        await sleep(650);
        if (cancelled || bootTokenRef.current !== token) return;

        await sleep(900);
        if (cancelled || bootTokenRef.current !== token) return;
        setStepStatus("sync", "done");

        await sleep(650);
        if (cancelled || bootTokenRef.current !== token) return;

        setPhase("complete");
      }
    }

    run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKey, simulateNoLink, simulateFastLoad, simulateProvisionError, simulateCheckError]);

  // ---------------------------
  // Linking progress loop
  // ---------------------------

  useEffect(() => {
    if (phase !== "linking") return;

    if (syncDone) {
      setLinkPercent(100);
      return;
    }

    let raf = 0;
    let cancelled = false;

    const start = Date.now();
    if (!linkingStartedAt.current) linkingStartedAt.current = start;

    function tick() {
      if (cancelled) return;

      const elapsed = Date.now() - (linkingStartedAt.current ?? start);
      const pct = clamp(progressFromElapsed(elapsed, syncDurationMs), 0, 97);

      setLinkPercent((prev) => (prev > pct ? prev : pct));

      const derived = deriveSubsteps(pct, syncDone);
      setSteps((prev) =>
        prev.map((s) => {
          if (s.id !== "sync" || !s.substeps) return s;

          const map = new Map<SubStepId, Status>();
          for (const d of derived) map.set(d.id, d.status);

          return {
            ...s,
            substeps: s.substeps.map((sub) => {
              const id = sub.id as SubStepId;
              const next = map.get(id);
              return next ? { ...sub, status: next } : sub;
            }),
          };
        })
      );

      raf = requestAnimationFrame(tick);
    }

    raf = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [phase, syncDone, syncDurationMs]);

  // ---------------------------
  // Actions for step 1 + 2 errors
  // ---------------------------

  async function retryProvision() {
    if (isRetrying) return;
    setIsRetrying(true);
    await sleep(350);
    setIsRetrying(false);

    const token = bootTokenRef.current;
    const res = await runProvision(token);
    if (!res.ok) return;

    // Continue to step 2
    await sleep(400);
    if (bootTokenRef.current !== token) return;

    const res2 = await runCheck(token);
    if (!res2.ok) return;

    const pehr = await mockPehrCall(simulateNoLink);
    if (bootTokenRef.current !== token) return;

    if (pehr.ehrLinkingRequired) {
      setPhase("needs_link");
      setStepStatus("connect", "active");
    } else {
      setStepStatus("connect", "active");
      await sleep(900);
      if (bootTokenRef.current !== token) return;
      setStepStatus("connect", "done");

      await sleep(650);
      if (bootTokenRef.current !== token) return;

      await sleep(900);
      if (bootTokenRef.current !== token) return;
      setStepStatus("sync", "done");

      await sleep(650);
      if (bootTokenRef.current !== token) return;
      setPhase("complete");
    }
  }

  async function retryCheck() {
    if (isRetrying) return;
    setIsRetrying(true);
    await sleep(350);
    setIsRetrying(false);

    const token = bootTokenRef.current;
    const res = await runCheck(token);
    if (!res.ok) return;

    const pehr = await mockPehrCall(simulateNoLink);
    if (bootTokenRef.current !== token) return;

    if (pehr.ehrLinkingRequired) {
      setPhase("needs_link");
      setStepStatus("connect", "active");
    } else {
      setStepStatus("connect", "active");
      await sleep(900);
      if (bootTokenRef.current !== token) return;
      setStepStatus("connect", "done");

      await sleep(650);
      if (bootTokenRef.current !== token) return;

      await sleep(900);
      if (bootTokenRef.current !== token) return;
      setStepStatus("sync", "done");

      await sleep(650);
      if (bootTokenRef.current !== token) return;
      setPhase("complete");
    }
  }

  function skipProvision() {
    // Skip ends this setup flow and takes the user to Home.
    setSkippedProvision(true);
    setProvisionErrored(false);
    setStepStatus("provision", "done");
    setPhase("complete");
  }

  function skipCheck() {
    // Skip ends this setup flow and takes the user to Home.
    setSkippedCheck(true);
    setCheckErrored(false);
    setStepStatus("check", "done");
    setPhase("complete");
  }

  // ---------------------------
  // Linking (connect CTA)
  // ---------------------------

  async function handleConnectClick() {
    // Pop-up should only open on an explicit user action.
    if (connectBusy) return;

    // Retry micro-state only when coming from a sync error.
    if (syncErrored) {
      setIsRetrying(true);
      await sleep(450);
      setIsRetrying(false);
      await sleep(150);
    }

    setConnectBusy(true);
    setSyncDone(false);
    setSyncErrored(false);
    setSkippedLinking(false);

    setSteps((prev) =>
      prev.map((s) => {
        if (s.id === "connect") return { ...s, status: "done" };
        if (s.id === "sync") return { ...s, status: "active" };
        return s;
      })
    );

    setPhase("linking");
    setLinkPercent(0);
    linkingStartedAt.current = Date.now();

    const duration = simulateFastLoad ? FAST_SYNC_MS : MOCK_SYNC_MS;
    setSyncDurationMs(duration);

    let w: Window | null = null;

    const overlayTimersRef = (window as any).__overlayTimersRef ?? {
      interval: null as any,
      stop: null as any,
    };
    (window as any).__overlayTimersRef = overlayTimersRef;

    const startOverlayPopup = (ms: number) => {
      setShowPopupOverlay(true);
      setPopupStage("ascension");

      if (overlayTimersRef.interval) window.clearInterval(overlayTimersRef.interval);
      if (overlayTimersRef.stop) window.clearTimeout(overlayTimersRef.stop);

      const stages: PopupStage[] = ["ascension", "cerner", "athena"];
      let idx = 0;

      overlayTimersRef.interval = window.setInterval(() => {
        idx = (idx + 1) % stages.length;
        setPopupStage(stages[idx]);
      }, 6000);

      overlayTimersRef.stop = window.setTimeout(() => {
        if (overlayTimersRef.interval) window.clearInterval(overlayTimersRef.interval);
        overlayTimersRef.interval = null;
        overlayTimersRef.stop = null;
        setShowPopupOverlay(false);
      }, ms);
    };

    try {
      // Smaller pop-up positioned top-right; user can still see the stepper.
      const popupW = 360;
      const popupH = 520;
      const dualScreenLeft = (window as any).screenLeft ?? window.screenX ?? 0;
      const dualScreenTop = (window as any).screenTop ?? window.screenY ?? 0;
      const winW = window.innerWidth || document.documentElement.clientWidth || screen.width;
      const left = Math.max(0, Math.round(dualScreenLeft + winW - popupW - 24));
      const top = Math.max(0, Math.round(dualScreenTop + 24));

      w = window.open("about:blank", "ehrLink", `width=${popupW},height=${popupH},left=${left},top=${top}`);

      if (!w) startOverlayPopup(duration);

      if (w) {
        w.document.title = "Link records";
        w.document.body.style.fontFamily = "system-ui, -apple-system, Segoe UI, Roboto";
        w.document.body.style.padding = "24px";
        w.document.body.innerHTML = `
          <h2 style="margin:0 0 10px">Linking your records</h2>
          <p style="margin:0 0 14px;color:#444">Keep this window open while we link your records.</p>
          <div style="display:flex;gap:10px;align-items:center;color:#111">
            <div style="width:10px;height:10px;border-radius:999px;background:#0ea5e9"></div>
            <span>Working...</span>
          </div>
        `;
      }

      await mockEhrPopupFlow();
      if (w && !w.closed) w.close();

      if (simulateLinkError) {
        await sleep(Math.max(1200, Math.round(duration * 0.2)));
        throw new Error("SIMULATED_SYNC_ERROR");
      }

      await mockServerSyncWait(duration);

      setSyncDone(true);
      setLinkPercent(100);
      setShowPopupOverlay(false);

      setSteps((prev) =>
        prev.map((s) => {
          if (s.id === "sync") {
            const doneSubs = s.substeps?.map((x) => ({ ...x, status: "done" as Status }));
            return { ...s, status: "done", substeps: doneSubs };
          }
          return s;
        })
      );

      setPhase("complete");
    } catch {
      try {
        if (w && !w.closed) w.close();
      } catch {
        // ignore
      }

      setShowPopupOverlay(false);
      setSyncErrored(true);
      setSteps((prev) => prev.map((s) => (s.id === "sync" ? { ...s, status: "error" } : s)));
      setPhase("linking");
    } finally {
      setConnectBusy(false);
    }
  }

  function handleSkipForNowLinking() {
    setSkippedLinking(true);
    setSyncErrored(false);

    setSteps((prev) =>
      prev.map((s) => {
        if (s.id === "sync") {
          const resetSubs = s.substeps?.map((x) => ({ ...x, status: "idle" as Status }));
          return { ...s, status: "idle", substeps: resetSubs };
        }
        return s;
      })
    );

    setPhase("complete");
  }

  const skippedAny = skippedProvision || skippedCheck || skippedLinking;

  // ---------------------------
  // Copy
  // ---------------------------

  const pageTitle = useMemo(() => {
    switch (phase) {
      case "needs_link":
        return "Connect your records";
      case "linking":
        return "Connecting your records";
      case "complete":
        return "All set";
      default:
        return "Setting up your account";
    }
  }, [phase]);

  const helperText = useMemo(() => {
    switch (phase) {
      case "needs_link":
        return "To view your medical history, we need to connect to your health system.";
      case "linking":
        return "We are getting your records ready. This can take up to 90 seconds.";
      case "complete":
        if (simulateNoLink) return "No records to connect right now.";
        if (skippedAny) return "You can keep going. We’ll keep trying to connect your records on Home.";
        return "All set.";
      default:
        return "We’re getting things ready. This should only take a moment.";
    }
  }, [phase, simulateNoLink, skippedAny]);

  const stepsBadgeText = useMemo(() => {
    if (simulateNoLink) return "No records";
    const activeIdx = steps.findIndex((s) => s.status === "active");
    const current = activeIdx >= 0 ? activeIdx + 1 : Math.max(1, completedCount);
    return `${current}/${steps.length} steps`;
  }, [simulateNoLink, steps, completedCount]);

  const allFlashOff = useMemo(() => Object.values(flashDoneMap).every((v) => v === false), [flashDoneMap]);

  // Auto-redirect: switch to full-screen success, then to Home.
  useEffect(() => {
    if (phase !== "complete") return;
    if (!allFlashOff) return;
    if (hasScheduledRedirectRef.current) return;

    hasScheduledRedirectRef.current = true;
    setIsRedirecting(true);
    setIsExitingToHome(false);
    setScreen("success");

    const t1 = window.setTimeout(() => setIsExitingToHome(true), 4000);
    const t2 = window.setTimeout(() => setScreen("home"), 4300);

    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      hasScheduledRedirectRef.current = false;
    };
  }, [phase, allFlashOff]);

  // ---------------------------
  // Render screens
  // ---------------------------

  if (screen === "home") {
    return (
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }}>
        <HomeScreen limited={skippedAny} />
      </motion.div>
    );
  }

  if (screen === "success") {
    const variant: SuccessVariant = simulateNoLink ? "uptodate" : skippedAny ? "limited" : "success";
    return (
      <motion.div
        initial={false}
        animate={{ opacity: isExitingToHome ? 0 : 1 }}
        transition={{ duration: 0.25 }}
        className="min-h-screen w-full bg-white"
      >
        <SuccessScreen variant={variant} isRedirecting={isRedirecting} />
      </motion.div>
    );
  }

  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-white to-slate-50">
      {showPopupOverlay ? <PopupOverlay stage={popupStage} /> : null}

      <div className="mx-auto max-w-4xl px-4 py-10 md:py-14">
        <Card className="rounded-3xl shadow-sm border-slate-200">
          <CardHeader className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 rounded-full px-3 text-xs"
                  onClick={() => setSimulateNoLink((v) => !v)}
                  title="Dev toggle: no records"
                >
                  {simulateNoLink ? "Dev: No records" : "Dev: Happy"}
                </Button>

                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 rounded-full px-3 text-xs"
                  onClick={() => setSimulateProvisionError((v) => !v)}
                  title="Dev toggle: step 1 error"
                >
                  {simulateProvisionError ? "Dev: Step1 err" : "Dev: Step1 ok"}
                </Button>

                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 rounded-full px-3 text-xs"
                  onClick={() => setSimulateCheckError((v) => !v)}
                  title="Dev toggle: step 2 error"
                >
                  {simulateCheckError ? "Dev: Step2 err" : "Dev: Step2 ok"}
                </Button>

                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 rounded-full px-3 text-xs"
                  onClick={() => setSimulateLinkError((v) => !v)}
                  title="Dev toggle: sync error"
                >
                  {simulateLinkError ? "Dev: Sync err" : "Dev: Sync ok"}
                </Button>

                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 rounded-full px-3 text-xs"
                  onClick={() => setSimulateFastLoad((v) => !v)}
                  title="Dev toggle: fast load"
                >
                  {simulateFastLoad ? "Dev: Fast" : "Dev: Normal"}
                </Button>

                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 rounded-full px-3 text-xs"
                  onClick={() => setRunKey((k) => k + 1)}
                  title="Restart simulation"
                >
                  Restart
                </Button>
              </div>

              <div className="flex items-center justify-between gap-3">
                <CardTitle className="text-xl md:text-2xl tracking-tight">{pageTitle}</CardTitle>

                <Badge variant="secondary" className="rounded-full px-3 py-1 text-xs">
                  {stepsBadgeText}
                </Badge>
              </div>

            <p className="text-sm md:text-base text-slate-600">{helperText}</p>

            {phase === "needs_link" || phase === "linking" ? (
              <p className="text-xs text-slate-500">A small window may open to link your records. Keep it open.</p>
            ) : null}
          </CardHeader>

          <CardContent className="space-y-3">
            <div className="space-y-3">
              {steps.map((step) => (
                <StepRow
                  key={step.id}
                  step={step}
                  phase={phase}
                  linkPercent={linkPercent}
                  onConnect={handleConnectClick}
                  onSkipLinking={handleSkipForNowLinking}
                  onRetryProvision={retryProvision}
                  onSkipProvision={skipProvision}
                  onRetryCheck={retryCheck}
                  onSkipCheck={skipCheck}
                  connectBusy={connectBusy}
                  isRetrying={isRetrying}
                  flashDone={flashDoneMap[step.id]}
                  provisionAttempts={provisionAttempts}
                  checkAttempts={checkAttempts}
                />
              ))}
            </div>

            {phase === "linking" ? <LongWaitHint startedAt={linkingStartedAt.current} percent={linkPercent} /> : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ---------------------------
// Step row
// ---------------------------

function StepRow(props: StepRowProps) {
  const {
    step,
    phase,
    linkPercent,
    onConnect,
    onSkipLinking,
    onRetryProvision,
    onSkipProvision,
    onRetryCheck,
    onSkipCheck,
    connectBusy,
    isRetrying,
    flashDone,
    provisionAttempts,
    checkAttempts,
  } = props;

  const isActive = step.status === "active";
  const isDone = step.status === "done";
  const isError = step.status === "error";

  const isSync = step.id === "sync";
  const showSyncOverlayError = isSync && isError;
  const showSyncBody = isSync && (isActive || isError);

  const showProvisionError = step.id === "provision" && isError;
  const showCheckError = step.id === "check" && isError;

  return (
    <motion.div
      layout="position"
      className={`rounded-3xl border p-4 md:p-5 transition-colors duration-400 ${
        isActive
          ? "border-slate-300 bg-white shadow-[0_2px_8px_rgba(15,23,42,0.04)]"
          : isDone
          ? flashDone
            ? "border-emerald-200 bg-[#E9FBE7]"
            : "border-slate-200/70 bg-[#FAFAFA]"
          : isError
          ? "border-slate-200 bg-white"
          : "border-slate-200/60 bg-white"
      }`}
    >
      <div className="flex items-start gap-4">
        <div className="mt-0.5">
          <StatusGlyph status={step.status} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="min-w-0">
            <p className={`truncate text-sm md:text-base font-semibold ${isActive ? "text-slate-900" : "text-[rgba(0,0,0,0.60)]"}`}>
              {step.label}
            </p>
            {step.description ? (
              <p className={`mt-1 text-sm ${isActive ? "text-slate-600" : "text-[rgba(0,0,0,0.60)]"}`}>{step.description}</p>
            ) : null}
          </div>

          {/* Step 1 error */}
          {showProvisionError ? (
            <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4">
              <p className="text-sm text-slate-700">We couldn’t set up your profile. Try again.</p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                <Button onClick={onRetryProvision} disabled={isRetrying} className="rounded-xl">
                  {isRetrying ? "Retrying..." : "Try again"}
                </Button>
                {provisionAttempts >= 2 ? (
                  <button type="button" onClick={onSkipProvision} className="text-sm underline text-slate-700">
                    Skip and go to Home
                  </button>
                ) : null}
              </div>
              <p className="mt-2 text-xs text-slate-600">If you skip, you’ll go to Home. We’ll try again there.</p>
              {provisionAttempts < 2 ? (
                <p className="mt-1 text-xs text-slate-600">If it fails again, you’ll be able to skip.</p>
              ) : null}
            </div>
          ) : null}

          {/* Step 2 error */}
          {showCheckError ? (
            <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4">
              <p className="text-sm text-slate-700">We couldn’t check for records. Try again.</p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                <Button onClick={onRetryCheck} disabled={isRetrying} className="rounded-xl">
                  {isRetrying ? "Retrying..." : "Try again"}
                </Button>
                {checkAttempts >= 2 ? (
                  <button type="button" onClick={onSkipCheck} className="text-sm underline text-slate-700">
                    Skip and go to Home
                  </button>
                ) : null}
              </div>
              <p className="mt-2 text-xs text-slate-600">If you skip, you’ll go to Home. We’ll try again there.</p>
              {checkAttempts < 2 ? (
                <p className="mt-1 text-xs text-slate-600">If it fails again, you’ll be able to skip.</p>
              ) : null}
            </div>
          ) : null}

          {/* SYNC: keep progress + substeps mounted; error overlays them */}
          {showSyncBody ? (
            <div className="mt-2 relative">
              <motion.div
                initial={false}
                animate={{ opacity: isError ? 0 : 1 }}
                transition={{ duration: 0.22 }}
                style={{ pointerEvents: isError ? "none" : "auto" }}
              >
                <div className="flex items-center justify-between text-xs text-slate-600 mb-1">
                  <span />
                  <span aria-hidden className="opacity-0 select-none">100%</span>
                </div>

                <div className="mt-1 h-2 w-full rounded-full bg-[rgba(0,0,0,0.10)] overflow-hidden">
  <div
    className="h-full rounded-full bg-[#1E69D2] transition-[width] duration-200 ease-out"
    style={{ width: `${clamp(linkPercent, 0, 100)}%` }}
  />
</div>

                <div className="mt-4 space-y-2.5">
                  {step.substeps?.map((sub) => (
                    <div key={sub.id} className="flex items-center gap-3">
                      <SubStatusDot status={sub.status} />
                      <span className="text-sm text-slate-700">{sub.label}</span>
                    </div>
                  ))}
                </div>
              </motion.div>

              <AnimatePresence>
                {showSyncOverlayError ? (
                  <motion.div
                    key="syncerr"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.22 }}
                    className="absolute inset-0 rounded-2xl border border-amber-200 bg-amber-50 p-4"
                  >
                    <p className="text-sm text-slate-700">We couldn’t connect your records. Try again.</p>
                    <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                      <Button onClick={onConnect} disabled={connectBusy || isRetrying} className="rounded-xl">
                        {isRetrying ? "Retrying..." : "Try again"}
                      </Button>
                      <button
                        type="button"
                        onClick={onSkipLinking}
                        className={`text-sm underline text-slate-700 ${isRetrying ? "pointer-events-none opacity-60" : ""}`}
                      >
                        Skip for now
                      </button>
                    </div>
                    <p className="mt-2 text-xs text-slate-600">We’ll try again next time you log in.</p>
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </div>
          ) : null}

          {/* Inline connect CTA */}
          {phase === "needs_link" && step.id === "connect" && isActive ? (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25 }}
              className="mt-4 rounded-2xl border border-slate-300 bg-[#F3FAFF] p-4 md:p-5"
            >
              <div className="space-y-3">
  <p className="text-sm text-slate-600">
    This will open a new tab. Please keep it open — it will close when finished.
  </p>

  <Button
    size="lg"
    onClick={onConnect}
    disabled={connectBusy}
    className="rounded-2xl px-6 bg-[#1E69D2] hover:bg-[#1E69D2]/90 text-white w-fit"
  >
    {connectBusy ? "Opening..." : "CONNECT RECORDS"}
    <ExternalLink className="ml-3 h-5 w-5 opacity-90" />
  </Button>
</div>
            </motion.div>
          ) : null}
        </div>
      </div>
    </motion.div>
  );
}

// ---------------------------
// Glyphs
// ---------------------------

function StatusGlyph({ status }: { status: Status }) {
  if (status === "done") return <CheckCircle2 className="h-7 w-7 text-slate-900" />;
  if (status === "error") return <AlertTriangle className="h-7 w-7 text-amber-600" />;
  if (status === "active") {
    return (
      <motion.div className="grid h-7 w-7 place-items-center" aria-label="In progress">
        <motion.div
          className="h-6 w-6 rounded-full border-2 border-slate-300 border-t-slate-900"
          animate={{ rotate: 360 }}
          transition={{ repeat: Infinity, duration: 1.1, ease: "linear" }}
        />
      </motion.div>
    );
  }
  return <div className="h-7 w-7 rounded-full border-2 border-slate-200/70" />;
}

function SubStatusDot({ status }: { status: Status }) {
  if (status === "done") return <div className="h-3 w-3 rounded-full bg-slate-900" />;
  if (status === "active") {
    return (
      <motion.div
        className="h-3 w-3 rounded-full bg-slate-400"
        animate={{ opacity: [0.4, 1, 0.4] }}
        transition={{ repeat: Infinity, duration: 1.2, ease: "easeInOut" }}
      />
    );
  }
  if (status === "error") return <div className="h-3 w-3 rounded-full bg-amber-500" />;
  return <div className="h-3 w-3 rounded-full bg-slate-200" />;
}

// ---------------------------
// Long-wait hint
// ---------------------------

function LongWaitHint({ startedAt, percent }: { startedAt: number | null; percent: number }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    setShow(false);
    if (!startedAt) return;

    const t = window.setTimeout(() => {
      if (percent < 88) setShow(true);
    }, 55_000);

    return () => window.clearTimeout(t);
  }, [startedAt, percent]);

  return (
    <AnimatePresence>
      {show ? (
        <motion.div
          key="longwait"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          className="rounded-2xl border border-slate-200 bg-white p-4"
        >
          <div className="flex items-start gap-3">
            <RefreshCw className="mt-0.5 h-5 w-5" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-slate-900">Still working…</p>
              <p className="text-xs text-slate-600">This can take a bit. Keep this tab open while we finish.</p>
            </div>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function HomeScreen({ limited }: { limited: boolean }) {
  return (
    <div className="min-h-screen w-full bg-white">
      <div className="mx-auto max-w-4xl px-4 py-10 md:py-14">
        <div className="rounded-3xl border border-slate-200 bg-white p-8">
          <h1 className="text-2xl font-semibold text-slate-900">Home</h1>
          <p className="mt-2 text-sm text-slate-600">
            {limited
              ? "Some features may not work yet. We’re still trying to connect your records."
              : "Home is loading. Your records may take a minute to show up."}
          </p>
        </div>
      </div>
    </div>
  );
}

function SuccessScreen({
  variant,
  isRedirecting,
}: {
  variant: SuccessVariant;
  isRedirecting: boolean;
}) {
  return (
    <div className="min-h-screen w-full bg-white">
      <div className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center px-6 py-10 text-center">
        <div className="grid h-14 w-14 place-items-center rounded-full bg-slate-50">
          <CheckCircle2 className="h-7 w-7 text-slate-900" />
        </div>

        {variant === "uptodate" ? (
          <>
            <h1 className="mt-6 text-2xl font-semibold tracking-tight text-slate-900">All set</h1>
            <p className="mt-3 text-sm text-slate-600">No records to connect right now.</p>
          </>
        ) : variant === "limited" ? (
          <>
            <h1 className="mt-6 text-2xl font-semibold tracking-tight text-slate-900">All set</h1>
            <p className="mt-3 text-sm text-slate-600">You can keep going. We’ll keep trying on Home.</p>
          </>
        ) : (
          <>
            <h1 className="mt-6 text-2xl font-semibold tracking-tight text-slate-900">All set</h1>
            <p className="mt-3 text-sm text-slate-600">We’ve linked your health records.</p>
            <p className="mt-2 text-sm text-slate-600">Your records may take a minute to show up on Home.</p>
          </>
        )}

        <p className="mt-6 text-sm text-slate-600">{isRedirecting ? "Taking you to Home..." : ""}</p>
      </div>
    </div>
  );
}

function PopupOverlay({ stage }: { stage: PopupStage }) {
  const title = stage === "cerner" ? "Cerner" : stage === "athena" ? "athenahealth" : "Ascension";

  return (
    <div className="pointer-events-none fixed inset-0 z-50">
      <div className="absolute right-6 top-6 w-[360px]">
        <div className="pointer-events-auto h-[520px] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <div className="text-sm font-medium text-slate-900">{title}</div>
            <div className="text-xs text-slate-500">Linking</div>
          </div>

          <div className="px-5 py-8">
            {stage === "ascension" ? (
              <>
                <p className="text-sm font-medium text-slate-900">Linking your records</p>
                <p className="mt-2 text-sm text-slate-600">Keep this window open while we link your records.</p>
                <div className="mt-6 h-10 w-10 rounded-full border-2 border-slate-300 border-t-slate-900 animate-spin" />
              </>
            ) : (
              <>
                <div className="flex justify-center">
                  <div className="text-lg font-semibold text-slate-700">{title}</div>
                </div>
                <div className="mt-8 flex justify-center">
                  <div className="h-10 w-10 rounded-full border-2 border-slate-300 border-t-slate-900 animate-spin" />
                </div>
                <p className="mt-6 text-center text-sm text-slate-600">Connecting...</p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------
// Minimal test hooks (no runtime impact)
// ---------------------------

function __assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

const _proc = (globalThis as any).process;
if (typeof _proc !== "undefined" && _proc.env && _proc.env.NODE_ENV === "test") {
  __assert(progressFromElapsed(0, MOCK_SYNC_MS) === 0, "progress should start at 0");
  __assert(progressFromElapsed(10_000, MOCK_SYNC_MS) === 25, "progress should reach 25% at 10s");
  __assert(progressFromElapsed(70_000, MOCK_SYNC_MS) === 90, "progress should reach 90% at 70s");
  __assert(progressFromElapsed(MOCK_SYNC_MS, MOCK_SYNC_MS) >= 96, "progress should be near-complete at cap");

  __assert(progressFromElapsed(0, FAST_SYNC_MS) === 0, "fast progress should start at 0");
  __assert(progressFromElapsed(FAST_SYNC_MS, FAST_SYNC_MS) >= 96, "fast progress should be near-complete at cap");
}
