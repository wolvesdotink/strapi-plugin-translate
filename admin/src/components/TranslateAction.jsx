// Document Action that renders a "Translate" button in the Edit View dropdown.
// Walks the user through four phases:
//   pick     — choose one or more target locales, optionally request a preview
//   running  — live progress bar (polls GET /translate/jobs/:id)
//   preview  — single-target preview: review the proposed payload diff before
//              committing it
//   summary  — terminal screen for done | partial | failed | cancelled
//
// Beyond locale picking, the pick step also shows:
//   • per-locale status pills (which locales already have content)
//   • a cost/token estimate updated when the selection changes
//   • a "Preview first" toggle (single-target only)
//   • last-selected locales remembered per (user, model) via localStorage

import React, { useEffect, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import { useFetchClient, useNotification } from "@strapi/strapi/admin";
import {
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  Field,
  Flex,
  Modal,
  MultiSelect,
  MultiSelectOption,
  ProgressBar,
  Typography,
} from "@strapi/design-system";
import {
  CheckCircle,
  Clock,
  Cross,
  CrossCircle,
  Earth,
  Loader,
  WarningCircle,
} from "@strapi/icons";
import pluginId from "../pluginId";

const POLL_INTERVAL_MS = 1000;
const ESTIMATE_DEBOUNCE_MS = 350;

const LAST_LOCALES_KEY_PREFIX = "strapi-plugin-translate:last-locales:";

const FORMAT_LABELS = {
  plain: "Text",
  html: "Rich text",
  blocks: "Editor",
};

const TARGET_STATE_INFO = {
  pending: { Icon: Clock, color: "neutral500", labelKey: "state.pending", labelDefault: "Queued" },
  running: { Icon: Loader, color: "primary600", labelKey: "state.running", labelDefault: "Translating…" },
  done: { Icon: CheckCircle, color: "success600", labelKey: "state.done", labelDefault: "Done" },
  failed: { Icon: CrossCircle, color: "danger600", labelKey: "state.failed", labelDefault: "Failed" },
  cancelled: { Icon: Cross, color: "neutral500", labelKey: "state.cancelled", labelDefault: "Cancelled" },
};

const emptyFormatProgress = () => ({
  plain: { done: 0, total: 0 },
  html: { done: 0, total: 0 },
  blocks: { done: 0, total: 0 },
});

const sumProgress = (p) =>
  ["plain", "html", "blocks"].reduce(
    (acc, k) => ({
      done: acc.done + (p?.[k]?.done || 0),
      total: acc.total + (p?.[k]?.total || 0),
    }),
    { done: 0, total: 0 }
  );

const extractErrorMessage = (err) =>
  (err && err.response && err.response.data && err.response.data.error
    ? err.response.data.error.message
    : null) ||
  (err && err.message) ||
  "Unknown error";

// Locale memo storage key — scoped by content type so a Page's last targets
// don't leak into a Product's pick step.
const lastLocalesKey = (model) =>
  `${LAST_LOCALES_KEY_PREFIX}${model || "global"}`;

const readLastLocales = (model) => {
  try {
    const raw = window.localStorage.getItem(lastLocalesKey(model));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
};

const writeLastLocales = (model, locales) => {
  try {
    window.localStorage.setItem(
      lastLocalesKey(model),
      JSON.stringify(locales)
    );
  } catch {
    /* localStorage unavailable — best-effort */
  }
};

const formatCost = (n) => {
  if (typeof n !== "number" || !isFinite(n)) return null;
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
};

const formatTokens = (n) => {
  if (typeof n !== "number" || !isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
};

// Truncate a long string for diff display. Diff values for richtext/blocks
// can be huge; show the first ~200 chars with an ellipsis.
const truncate = (v, n = 240) => {
  if (typeof v !== "string") return JSON.stringify(v);
  if (v.length <= n) return v;
  return `${v.slice(0, n)}…`;
};

const TranslateModal = ({ onClose, model, documentId, sourceLocale }) => {
  const { formatMessage } = useIntl();
  const { get, post } = useFetchClient();
  const { toggleNotification } = useNotification();

  const [phase, setPhase] = useState("pick");
  const [allLocales, setAllLocales] = useState([]);
  const [targets, setTargets] = useState(() => readLastLocales(model));
  const [jobId, setJobId] = useState(null);
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const [cancelling, setCancelling] = useState(false);
  const [starting, setStarting] = useState(false);

  // Preview-flow state
  const [previewMode, setPreviewMode] = useState(false);
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [committingPreview, setCommittingPreview] = useState(false);

  // Cost estimate + locale-status pills
  const [localeStatus, setLocaleStatus] = useState([]);
  const [localesError, setLocalesError] = useState(null);
  const [localeStatusError, setLocaleStatusError] = useState(null);
  const [estimate, setEstimate] = useState(null);
  const [estimateLoading, setEstimateLoading] = useState(false);
  const [estimateError, setEstimateError] = useState(null);

  // Load locales + per-locale status of this entry once on mount.
  useEffect(() => {
    let cancelled = false;
    get(`/translate/locales`)
      .then((res) => {
        if (cancelled) return;
        setAllLocales(res.data || []);
        setLocalesError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.warn("[translate] could not fetch locales", err);
        setLocalesError(extractErrorMessage(err));
      });
    if (model && documentId) {
      post(`/translate/content/locale-status`, { uid: model, documentId })
        .then((res) => {
          if (cancelled) return;
          setLocaleStatus(res.data?.locales || []);
          setLocaleStatusError(null);
        })
        .catch((err) => {
          if (cancelled) return;
          // eslint-disable-next-line no-console
          console.warn("[translate] could not fetch locale status", err);
          setLocaleStatusError(extractErrorMessage(err));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [get, post, model, documentId]);

  // Debounced /estimate call whenever targets change.
  useEffect(() => {
    if (phase !== "pick") return undefined;
    if (!model || !documentId || targets.length === 0) {
      setEstimate(null);
      setEstimateError(null);
      return undefined;
    }
    const handle = setTimeout(async () => {
      setEstimateLoading(true);
      setEstimateError(null);
      try {
        const res = await post(`/translate/estimate`, {
          uid: model,
          documentId,
          sourceLocale,
          targetLocales: targets,
        });
        setEstimate(res.data);
      } catch (err) {
        setEstimateError(extractErrorMessage(err));
        setEstimate(null);
      } finally {
        setEstimateLoading(false);
      }
    }, ESTIMATE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets, phase, model, documentId, sourceLocale]);

  // Poll job status while running.
  useEffect(() => {
    if (phase !== "running" || !jobId) return undefined;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await get(`/translate/jobs/${jobId}`);
        if (cancelled) return;
        const jobData = res.data;
        if (jobData) setJob(jobData);
        if (!jobData) return;
        if (
          jobData.state === "done" ||
          jobData.state === "partial" ||
          jobData.state === "cancelled"
        ) {
          setPhase("summary");
        } else if (jobData.state === "failed") {
          setError(jobData.error || "Translation failed");
          setPhase("summary");
        }
      } catch (err) {
        if (cancelled) return;
        if (err?.response?.status === 404) {
          setError("Translation job lost (server may have restarted)");
          setPhase("summary");
        }
      }
    };
    tick();
    const interval = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [phase, jobId, get]);

  // ---------- Derived ----------

  const targetLocales = useMemo(
    () => allLocales.filter((l) => l.code !== sourceLocale),
    [allLocales, sourceLocale]
  );
  const localeNameMap = useMemo(() => {
    const m = {};
    for (const l of allLocales) m[l.code] = l.name;
    return m;
  }, [allLocales]);
  const localeName = (code) => localeNameMap[code] || code;
  const sourceDisplayName =
    localeNameMap[sourceLocale] || sourceLocale || "current locale";

  // Filter remembered locales to ones that still exist in the project.
  useEffect(() => {
    if (targetLocales.length === 0) return;
    const valid = new Set(targetLocales.map((l) => l.code));
    setTargets((cur) => {
      const next = cur.filter((c) => valid.has(c));
      return next.length === cur.length ? cur : next;
    });
  }, [targetLocales]);

  const localeStatusByCode = useMemo(() => {
    const out = {};
    for (const s of localeStatus) out[s.locale] = s;
    return out;
  }, [localeStatus]);

  const overwriteTargets = targets.filter(
    (code) => localeStatusByCode[code]?.exists
  );
  // Locales whose status probe failed — we can't say whether they have
  // content, so warn instead of staying silent.
  const unknownTargets = targets.filter(
    (code) => localeStatusByCode[code]?.unknown
  );

  const previewAvailable = targets.length === 1;
  const effectivePreview = previewMode && previewAvailable;

  // Pending until we have a job snapshot. Build a placeholder list from the
  // picker selection so the running screen has something to render before the
  // first poll returns.
  const jobTargets = job?.targets || targets.map((locale) => ({
    locale,
    state: "pending",
    progress: emptyFormatProgress(),
    result: null,
    error: null,
  }));
  const activeIdx = job?.activeTargetIndex ?? -1;
  const totalTargets = jobTargets.length;
  const activeTarget = activeIdx >= 0 ? jobTargets[activeIdx] : null;

  const activeChunks = activeTarget
    ? sumProgress(activeTarget.progress)
    : { done: 0, total: 0 };

  const finishedSlices = jobTargets.filter(
    (t) => t.state === "done" || t.state === "failed" || t.state === "cancelled"
  ).length;
  const runningSliceFraction =
    activeTarget && activeTarget.state === "running" && activeChunks.total > 0
      ? activeChunks.done / activeChunks.total
      : 0;
  const overallPct =
    totalTargets > 0
      ? Math.min(
          100,
          Math.round(((finishedSlices + runningSliceFraction) / totalTargets) * 100)
        )
      : 0;

  const activeBreakdown = activeTarget
    ? ["plain", "html", "blocks"]
        .filter((k) => (activeTarget.progress[k]?.total || 0) > 0)
        .map((k) => ({
          key: k,
          label: FORMAT_LABELS[k],
          done: activeTarget.progress[k].done,
          total: activeTarget.progress[k].total,
        }))
    : [];

  const doneCount = jobTargets.filter((t) => t.state === "done").length;
  const failedCount = jobTargets.filter((t) => t.state === "failed").length;
  const cancelledCount = jobTargets.filter((t) => t.state === "cancelled").length;
  const warningsCount = jobTargets.reduce(
    (sum, t) => sum + (t.result?.warnings?.length || 0),
    0
  );

  const isSingleTargetCleanSuccess =
    phase === "summary" &&
    totalTargets === 1 &&
    jobTargets[0].state === "done" &&
    (jobTargets[0].result?.warnings?.length || 0) === 0;

  // ---------- Effects ----------

  const reloadInLocale = (locale) => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("plugins[i18n][locale]", locale);
    window.location.href = url.toString();
  };

  useEffect(() => {
    if (!isSingleTargetCleanSuccess) return;
    const locale = jobTargets[0].locale;
    toggleNotification({
      type: "success",
      message: formatMessage(
        {
          id: `${pluginId}.toast.success`,
          defaultMessage: "Translated to {locale}. Reloading…",
        },
        { locale: localeName(locale) }
      ),
    });
    reloadInLocale(locale);
  }, [isSingleTargetCleanSuccess]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (phase !== "summary" || isSingleTargetCleanSuccess) return;
    if (totalTargets <= 1) return;
    if (doneCount === totalTargets) {
      toggleNotification({
        type: "success",
        message: formatMessage(
          {
            id: `${pluginId}.toast.multiSuccess`,
            defaultMessage: "Translated to {count} locales.",
          },
          { count: doneCount }
        ),
      });
    } else if (doneCount > 0) {
      toggleNotification({
        type: "warning",
        message: formatMessage(
          {
            id: `${pluginId}.toast.multiPartial`,
            defaultMessage:
              "Translated {done} of {total} locales — review the rest.",
          },
          { done: doneCount, total: totalTargets }
        ),
      });
    }
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- Actions ----------

  const startTranslation = async () => {
    if (!targets.length) {
      toggleNotification({
        type: "warning",
        message: formatMessage({
          id: `${pluginId}.toast.pickLocale`,
          defaultMessage: "Please pick at least one target locale.",
        }),
      });
      return;
    }
    // Persist before launching so a refresh during running still remembers.
    writeLastLocales(model, targets);

    // Preview branch — single-target only, short-circuits the job flow.
    if (effectivePreview) {
      await startPreview();
      return;
    }

    setStarting(true);
    try {
      const res = await post(`/translate/document`, {
        uid: model,
        documentId,
        sourceLocale,
        targetLocales: targets,
      });
      setJobId(res.data.jobId);
      setJob(null);
      setPhase("running");
    } catch (err) {
      const message = extractErrorMessage(err);
      setError(message);
      setPhase("summary");
      toggleNotification({
        type: "danger",
        message: formatMessage(
          {
            id: `${pluginId}.toast.failure`,
            defaultMessage: "Translation failed: {error}",
          },
          { error: message }
        ),
      });
    } finally {
      setStarting(false);
    }
  };

  const startPreview = async () => {
    setPreviewLoading(true);
    setError(null);
    try {
      const res = await post(`/translate/preview`, {
        uid: model,
        documentId,
        sourceLocale,
        targetLocale: targets[0],
      });
      setPreview(res.data);
      setPhase("preview");
    } catch (err) {
      const message = extractErrorMessage(err);
      // Stay on the pick phase so the user can retry; the toast surfaces
      // the error and the picker is re-enabled because previewLoading
      // clears in the finally block. Jumping to summary would dead-end the
      // flow (no retry affordance, only Close).
      setError(message);
      toggleNotification({
        type: "danger",
        message: formatMessage(
          {
            id: `${pluginId}.toast.previewFailure`,
            defaultMessage: "Preview failed: {error}",
          },
          { error: message }
        ),
      });
    } finally {
      setPreviewLoading(false);
    }
  };

  const acceptPreview = async () => {
    if (!preview?.previewId) return;
    setCommittingPreview(true);
    try {
      await post(`/translate/preview/${preview.previewId}/accept`);
      toggleNotification({
        type: "success",
        message: formatMessage(
          {
            id: `${pluginId}.toast.previewAccepted`,
            defaultMessage: "Saved translation to {locale}. Reloading…",
          },
          { locale: localeName(targets[0]) }
        ),
      });
      reloadInLocale(targets[0]);
    } catch (err) {
      toggleNotification({
        type: "danger",
        message: formatMessage(
          {
            id: `${pluginId}.toast.previewAcceptFailed`,
            defaultMessage: "Failed to apply preview: {error}",
          },
          { error: extractErrorMessage(err) }
        ),
      });
      setCommittingPreview(false);
    }
  };

  const discardPreview = async () => {
    if (!preview?.previewId) {
      onClose();
      return;
    }
    try {
      await post(`/translate/preview/${preview.previewId}/discard`);
    } catch {
      /* best effort — preview will TTL out anyway */
    }
    onClose();
  };

  const requestCancel = async () => {
    if (!jobId || cancelling) return;
    setCancelling(true);
    try {
      await post(`/translate/jobs/${jobId}/cancel`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[translate] cancel request failed", err);
    }
  };

  const selectAll = () => setTargets(targetLocales.map((l) => l.code));
  const clearAll = () => setTargets([]);

  // ---------- Render helpers ----------

  const renderStatusPills = () => {
    if (targetLocales.length === 0) return null;
    return (
      <Flex
        gap={2}
        wrap="wrap"
        alignItems="center"
        paddingTop={1}
        paddingBottom={1}
      >
        <Typography variant="pi" textColor="neutral600" fontWeight="bold">
          {formatMessage({
            id: `${pluginId}.dialog.entryStatus`,
            defaultMessage: "Status of this entry:",
          })}
        </Typography>
        {targetLocales.map((l) => {
          const s = localeStatusByCode[l.code];
          const exists = !!s?.exists;
          return (
            <Badge
              key={l.code}
              backgroundColor={exists ? "success100" : "neutral150"}
              textColor={exists ? "success700" : "neutral700"}
              size="S"
            >
              {l.code.toUpperCase()} {exists ? "✓" : "—"}
            </Badge>
          );
        })}
      </Flex>
    );
  };

  const renderEstimateCard = () => {
    if (targets.length === 0) return null;
    return (
      <Box
        padding={3}
        background="neutral100"
        hasRadius
        borderColor="neutral200"
        borderWidth="1px"
        borderStyle="solid"
      >
        <Flex direction="column" alignItems="stretch" gap={2}>
          <Flex justifyContent="space-between" alignItems="baseline" gap={3}>
            <Typography variant="pi" fontWeight="bold" textColor="neutral700">
              {formatMessage({
                id: `${pluginId}.dialog.estimateTitle`,
                defaultMessage: "Translation estimate",
              })}
            </Typography>
            {estimateLoading && (
              <Typography variant="pi" textColor="neutral500">
                {formatMessage({
                  id: `${pluginId}.dialog.estimateLoading`,
                  defaultMessage: "Calculating…",
                })}
              </Typography>
            )}
          </Flex>
          {estimateError && (
            <Typography variant="pi" textColor="danger600">
              {estimateError}
            </Typography>
          )}
          {estimate && (
            <Flex direction="column" gap={1} alignItems="stretch">
              <Flex gap={4} wrap="wrap">
                <Typography variant="pi" textColor="neutral700">
                  <strong>
                    {formatTokens(estimate.inputTokens)}
                  </strong>{" "}
                  {formatMessage({
                    id: `${pluginId}.dialog.estimateInputTokens`,
                    defaultMessage: "input tokens",
                  })}
                </Typography>
                <Typography variant="pi" textColor="neutral700">
                  ~
                  <strong>{formatTokens(estimate.estimatedOutputTokens)}</strong>{" "}
                  {formatMessage({
                    id: `${pluginId}.dialog.estimateOutputTokens`,
                    defaultMessage: "output tokens",
                  })}
                </Typography>
                {formatCost(estimate.estimatedCostUsd) && (
                  <Typography variant="pi" textColor="primary700">
                    <strong>
                      ≈{formatCost(estimate.estimatedCostUsd)}
                    </strong>{" "}
                    {formatMessage(
                      {
                        id: `${pluginId}.dialog.estimateCostSuffix`,
                        defaultMessage:
                          "across {count, plural, one {# locale} other {# locales}}",
                      },
                      { count: estimate.targets }
                    )}
                  </Typography>
                )}
              </Flex>
              <Flex gap={3} wrap="wrap">
                {["plain", "html", "blocks"]
                  .filter((k) => (estimate.groups?.[k]?.items || 0) > 0)
                  .map((k, i, arr) => (
                    <React.Fragment key={k}>
                      <Typography variant="pi" textColor="neutral600">
                        {estimate.groups[k].items} {FORMAT_LABELS[k]}
                      </Typography>
                      {i < arr.length - 1 && (
                        <Typography variant="pi" textColor="neutral400">
                          ·
                        </Typography>
                      )}
                    </React.Fragment>
                  ))}
              </Flex>
              {Array.isArray(estimate.components) && estimate.components.length > 0 && (
                <Typography variant="pi" textColor="neutral600">
                  {formatMessage(
                    {
                      id: `${pluginId}.dialog.estimateComponents`,
                      defaultMessage:
                        "Components: {names}",
                    },
                    {
                      names: estimate.components
                        .map((c) => c.split(".").pop())
                        .join(", "),
                    }
                  )}
                </Typography>
              )}
            </Flex>
          )}
          {overwriteTargets.length > 0 && (
            <Flex
              gap={2}
              alignItems="center"
              padding={2}
              background="warning100"
              hasRadius
            >
              <Box color="warning700" aria-hidden>
                <WarningCircle width="1rem" height="1rem" />
              </Box>
              <Typography variant="pi" textColor="warning700">
                {formatMessage(
                  {
                    id: `${pluginId}.dialog.overwriteWarning`,
                    defaultMessage:
                      "{count, plural, one {# locale already has} other {# locales already have}} content and will be overwritten: {names}",
                  },
                  {
                    count: overwriteTargets.length,
                    names: overwriteTargets
                      .map((c) => localeName(c))
                      .join(", "),
                  }
                )}
              </Typography>
            </Flex>
          )}
          {(unknownTargets.length > 0 || localeStatusError) && (
            <Flex
              gap={2}
              alignItems="center"
              padding={2}
              background="warning100"
              hasRadius
            >
              <Box color="warning700" aria-hidden>
                <WarningCircle width="1rem" height="1rem" />
              </Box>
              <Typography variant="pi" textColor="warning700">
                {formatMessage(
                  {
                    id: `${pluginId}.dialog.overwriteUnknown`,
                    defaultMessage:
                      "Could not check whether the target locale(s) already have content; they may be overwritten.",
                  }
                )}
              </Typography>
            </Flex>
          )}
        </Flex>
      </Box>
    );
  };

  const renderTargetList = ({ highlightActive }) => (
    <Flex direction="column" alignItems="stretch" gap={1}>
      {jobTargets.map((t, i) => {
        const info = TARGET_STATE_INFO[t.state] || TARGET_STATE_INFO.pending;
        const Icon = info.Icon;
        const isActive = highlightActive && i === activeIdx && t.state === "running";
        const warnings = t.result?.warnings?.length || 0;
        return (
          <Flex
            key={t.locale}
            gap={3}
            alignItems="center"
            justifyContent="space-between"
            paddingTop={2}
            paddingBottom={2}
            paddingLeft={3}
            paddingRight={3}
            background={isActive ? "primary100" : "neutral0"}
            hasRadius
            borderColor={isActive ? "primary200" : "neutral200"}
            borderWidth="1px"
            borderStyle="solid"
          >
            <Flex gap={2} alignItems="center" shrink={0}>
              <Box color={info.color} aria-hidden>
                <Icon width="1rem" height="1rem" />
              </Box>
              <Typography variant="omega" fontWeight="semiBold">
                {localeName(t.locale)}
              </Typography>
              <Typography variant="pi" textColor="neutral500">
                ({t.locale})
              </Typography>
            </Flex>
            <Flex gap={3} alignItems="center">
              {t.state === "running" && activeChunks.total > 0 && (
                <Typography variant="pi" textColor="neutral600">
                  {formatMessage(
                    {
                      id: `${pluginId}.progress.chunks`,
                      defaultMessage: "{done} of {total} chunks translated",
                    },
                    { done: activeChunks.done, total: activeChunks.total }
                  )}
                </Typography>
              )}
              {t.state === "failed" && t.error && (
                <Typography
                  variant="pi"
                  textColor="danger600"
                  title={t.error}
                  ellipsis
                  style={{ maxWidth: 220 }}
                >
                  {t.error}
                </Typography>
              )}
              {t.state === "done" && warnings > 0 && (
                <Typography variant="pi" textColor="warning700">
                  {formatMessage(
                    {
                      id: `${pluginId}.summary.warningsCount`,
                      defaultMessage: "{count} skipped",
                    },
                    { count: warnings }
                  )}
                </Typography>
              )}
              {t.state !== "running" && t.state !== "pending" && (
                <Typography variant="pi" textColor={info.color}>
                  {formatMessage({
                    id: `${pluginId}.${info.labelKey}`,
                    defaultMessage: info.labelDefault,
                  })}
                </Typography>
              )}
              {t.state === "done" && (
                <Button
                  size="S"
                  variant="tertiary"
                  onClick={() => reloadInLocale(t.locale)}
                >
                  {formatMessage(
                    {
                      id: `${pluginId}.action.openLocale`,
                      defaultMessage: "Open",
                    }
                  )}
                </Button>
              )}
            </Flex>
          </Flex>
        );
      })}
    </Flex>
  );

  const summaryAlert = () => {
    if (failedCount === totalTargets && doneCount === 0) {
      return {
        variant: "danger",
        title: formatMessage({
          id: `${pluginId}.summary.failed`,
          defaultMessage: "Translation failed",
        }),
        body: error || formatMessage({
          id: `${pluginId}.summary.failedBody`,
          defaultMessage: "None of the target locales were translated.",
        }),
      };
    }
    if (cancelledCount > 0 && doneCount < totalTargets) {
      return {
        variant: "default",
        title: formatMessage({
          id: `${pluginId}.summary.cancelled`,
          defaultMessage: "Translation cancelled",
        }),
        body: formatMessage(
          {
            id: `${pluginId}.summary.cancelledBody`,
            defaultMessage:
              "Translated {done} of {total} locales before cancelling.",
          },
          { done: doneCount, total: totalTargets }
        ),
      };
    }
    if (failedCount > 0 && doneCount > 0) {
      return {
        variant: "warning",
        title: formatMessage(
          {
            id: `${pluginId}.summary.partial`,
            defaultMessage: "Translated {done} of {total} locales",
          },
          { done: doneCount, total: totalTargets }
        ),
        body: formatMessage({
          id: `${pluginId}.summary.partialBody`,
          defaultMessage:
            "Some locales failed — see the list below for details.",
        }),
      };
    }
    if (warningsCount > 0) {
      return {
        variant: "warning",
        title: formatMessage(
          {
            id: `${pluginId}.summary.allDoneWithWarnings`,
            defaultMessage: "Translated to {count} locale(s) with warnings",
          },
          { count: doneCount }
        ),
        body: formatMessage(
          {
            id: `${pluginId}.summary.warningsIntro`,
            defaultMessage:
              "{count} reference(s) across the translated entries point at records that no longer exist. They were left empty — please review and re-link them manually.",
          },
          { count: warningsCount }
        ),
      };
    }
    return {
      variant: "success",
      title: formatMessage(
        {
          id: `${pluginId}.summary.allDone`,
          defaultMessage:
            "Translated to {count, plural, one {# locale} other {# locales}}",
        },
        { count: doneCount }
      ),
      body: formatMessage({
        id: `${pluginId}.summary.allDoneBody`,
        defaultMessage: "Pick a locale below to open its translated entry.",
      }),
    };
  };

  // ---------- Render ----------

  return (
    <>
      <Modal.Body>
        {phase === "pick" && (
          <Flex direction="column" alignItems="stretch" gap={5} padding={2}>
            <Flex gap={3} alignItems="flex-start">
              <Box
                background="primary100"
                padding={2}
                hasRadius
                shrink={0}
                color="primary600"
              >
                <Earth />
              </Box>
              <Box>
                <Typography variant="omega" fontWeight="semiBold" tag="p">
                  {formatMessage(
                    {
                      id: `${pluginId}.dialog.introTitle`,
                      defaultMessage: "Translate from {source}",
                    },
                    { source: sourceDisplayName }
                  )}
                </Typography>
                <Box paddingTop={1}>
                  <Typography variant="pi" textColor="neutral600">
                    {formatMessage({
                      id: `${pluginId}.dialog.introBody`,
                      defaultMessage:
                        "Translations are run sequentially. Each selected target locale will be overwritten. Markdown, HTML and rich-text structure are preserved.",
                    })}
                  </Typography>
                </Box>
              </Box>
            </Flex>

            <Field.Root name="target-locales">
              <Flex justifyContent="space-between" alignItems="flex-end" paddingBottom={1}>
                <Field.Label>
                  {formatMessage({
                    id: `${pluginId}.dialog.targetLocales`,
                    defaultMessage: "Target locales",
                  })}
                </Field.Label>
                <Flex gap={2}>
                  <Button
                    variant="tertiary"
                    size="S"
                    onClick={selectAll}
                    disabled={
                      !targetLocales.length ||
                      targets.length === targetLocales.length
                    }
                  >
                    {formatMessage(
                      {
                        id: `${pluginId}.dialog.selectAll`,
                        defaultMessage: "Select all ({count})",
                      },
                      { count: targetLocales.length }
                    )}
                  </Button>
                  <Button
                    variant="tertiary"
                    size="S"
                    onClick={clearAll}
                    disabled={!targets.length}
                  >
                    {formatMessage({
                      id: `${pluginId}.dialog.clearAll`,
                      defaultMessage: "Clear",
                    })}
                  </Button>
                </Flex>
              </Flex>
              <MultiSelect
                value={targets}
                onChange={(v) =>
                  setTargets(Array.isArray(v) ? v.map(String) : [])
                }
                disabled={!targetLocales.length}
                placeholder={formatMessage({
                  id: `${pluginId}.dialog.selectLocales`,
                  defaultMessage: "Select one or more locales",
                })}
                withTags
                customizeContent={(values) =>
                  formatMessage(
                    {
                      id: `${pluginId}.dialog.selectedCount`,
                      defaultMessage: "{count} selected",
                    },
                    { count: (values || []).length }
                  )
                }
              >
                {targetLocales.map((l) => (
                  <MultiSelectOption key={l.code} value={l.code}>
                    {l.name} ({l.code})
                  </MultiSelectOption>
                ))}
              </MultiSelect>
              {localesError && (
                <Field.Error>
                  {formatMessage(
                    {
                      id: `${pluginId}.dialog.localesFetchError`,
                      defaultMessage:
                        "Could not load locales: {error}",
                    },
                    { error: localesError }
                  )}
                </Field.Error>
              )}
            </Field.Root>

            {renderStatusPills()}

            {error && (
              <Alert
                variant="danger"
                title={formatMessage({
                  id: `${pluginId}.dialog.pickErrorTitle`,
                  defaultMessage: "Last attempt failed",
                })}
                closeLabel=""
              >
                {error}
              </Alert>
            )}

            {targets.length > 0 && renderEstimateCard()}

            {previewAvailable && (
              <Flex gap={2} alignItems="center">
                <Checkbox
                  name="preview-mode"
                  checked={previewMode}
                  onCheckedChange={(v) => setPreviewMode(!!v)}
                >
                  {formatMessage({
                    id: `${pluginId}.dialog.previewToggle`,
                    defaultMessage:
                      "Preview before saving (review diff before overwriting)",
                  })}
                </Checkbox>
              </Flex>
            )}
          </Flex>
        )}

        {phase === "running" && (
          <Flex direction="column" alignItems="stretch" gap={5} padding={2}>
            <Flex justifyContent="space-between" alignItems="flex-end" gap={4}>
              <Box>
                <Typography
                  variant="pi"
                  textColor="neutral600"
                  fontWeight="bold"
                  tag="p"
                >
                  {formatMessage({
                    id: `${pluginId}.dialog.runningLabel`,
                    defaultMessage: "In progress",
                  })}
                </Typography>
                <Box paddingTop={1}>
                  <Typography variant="beta" tag="p">
                    {activeTarget ? (
                      totalTargets === 1 ? (
                        formatMessage(
                          {
                            id: `${pluginId}.dialog.running`,
                            defaultMessage: "Translating to {locale}…",
                          },
                          { locale: localeName(activeTarget.locale) }
                        )
                      ) : (
                        formatMessage(
                          {
                            id: `${pluginId}.dialog.runningMulti`,
                            defaultMessage:
                              "Translating to {locale} ({current} of {total})",
                          },
                          {
                            locale: localeName(activeTarget.locale),
                            current: activeIdx + 1,
                            total: totalTargets,
                          }
                        )
                      )
                    ) : (
                      formatMessage({
                        id: `${pluginId}.dialog.starting`,
                        defaultMessage: "Starting translation…",
                      })
                    )}
                  </Typography>
                </Box>
              </Box>
              <Typography
                variant="alpha"
                textColor="primary600"
                fontWeight="bold"
              >
                {overallPct}%
              </Typography>
            </Flex>

            <ProgressBar value={overallPct} max={100} size="M" />

            {activeBreakdown.length > 0 && (
              <Flex justifyContent="flex-end" gap={2} alignItems="center" wrap="wrap">
                {activeBreakdown.map((b, i) => (
                  <React.Fragment key={b.key}>
                    {i > 0 && (
                      <Typography variant="pi" textColor="neutral400">
                        ·
                      </Typography>
                    )}
                    <Typography variant="pi" textColor="neutral600">
                      {b.label} {b.done}/{b.total}
                    </Typography>
                  </React.Fragment>
                ))}
              </Flex>
            )}

            {totalTargets > 1 && renderTargetList({ highlightActive: true })}

            {cancelling && (
              <Box
                padding={3}
                background="neutral100"
                hasRadius
                borderColor="neutral200"
              >
                <Typography variant="pi" textColor="neutral700">
                  {formatMessage({
                    id: `${pluginId}.dialog.cancelling`,
                    defaultMessage:
                      "Cancellation requested — waiting for in-flight chunks to abort…",
                  })}
                </Typography>
              </Box>
            )}
          </Flex>
        )}

        {phase === "preview" && preview && (
          <Flex direction="column" alignItems="stretch" gap={4} padding={2}>
            <Alert
              variant="default"
              title={formatMessage(
                {
                  id: `${pluginId}.preview.title`,
                  defaultMessage: "Preview translation to {locale}",
                },
                { locale: localeName(targets[0]) }
              )}
              closeLabel=""
            >
              {formatMessage(
                {
                  id: `${pluginId}.preview.intro`,
                  defaultMessage:
                    "Review the {count, plural, one {# proposed change} other {# proposed changes}} below. Nothing is saved until you click Apply.",
                },
                { count: preview.diff?.length || 0 }
              )}
            </Alert>

            {preview.warnings && preview.warnings.length > 0 && (
              <Alert
                variant="warning"
                title={formatMessage(
                  {
                    id: `${pluginId}.preview.warningsTitle`,
                    defaultMessage:
                      "{count, plural, one {# stale reference skipped} other {# stale references skipped}}",
                  },
                  { count: preview.warnings.length }
                )}
                closeLabel=""
              >
                {preview.warnings.map((w, i) => (
                  <Box key={i} paddingTop={1}>
                    <Typography variant="pi" textColor="warning700">
                      {w.label} — {w.target}#{w.id}
                    </Typography>
                  </Box>
                ))}
              </Alert>
            )}

            <Box
              padding={3}
              background="neutral100"
              hasRadius
              borderColor="neutral200"
              borderWidth="1px"
              borderStyle="solid"
              style={{ maxHeight: 360, overflowY: "auto" }}
            >
              {(preview.diff || []).length === 0 && (
                <Typography variant="pi" textColor="neutral600">
                  {formatMessage({
                    id: `${pluginId}.preview.noDiff`,
                    defaultMessage: "No textual differences detected.",
                  })}
                </Typography>
              )}
              {(preview.diff || []).slice(0, 100).map((d, i) => (
                <Box key={i} paddingBottom={2}>
                  <Typography variant="pi" fontWeight="bold" textColor="neutral700">
                    {d.path}
                  </Typography>
                  <Box paddingTop={1}>
                    <Typography
                      variant="pi"
                      textColor="danger700"
                      tag="div"
                      style={{ whiteSpace: "pre-wrap" }}
                    >
                      − {truncate(d.before)}
                    </Typography>
                    <Typography
                      variant="pi"
                      textColor="success700"
                      tag="div"
                      style={{ whiteSpace: "pre-wrap" }}
                    >
                      + {truncate(d.after)}
                    </Typography>
                  </Box>
                </Box>
              ))}
              {(preview.diff || []).length > 100 && (
                <Typography variant="pi" textColor="neutral500">
                  {formatMessage(
                    {
                      id: `${pluginId}.preview.truncated`,
                      defaultMessage:
                        "Showing first 100 of {total} changes.",
                    },
                    { total: preview.diff.length }
                  )}
                </Typography>
              )}
            </Box>
          </Flex>
        )}

        {phase === "summary" && !isSingleTargetCleanSuccess && (
          <Flex direction="column" alignItems="stretch" gap={4} padding={2}>
            {(() => {
              const a = summaryAlert();
              return (
                <Alert
                  variant={a.variant}
                  title={a.title}
                  closeLabel={formatMessage({
                    id: `${pluginId}.action.close`,
                    defaultMessage: "Close",
                  })}
                  onClose={onClose}
                >
                  {a.body}
                </Alert>
              );
            })()}
            {totalTargets > 0 && renderTargetList({ highlightActive: false })}
          </Flex>
        )}

        {phase === "summary" && isSingleTargetCleanSuccess && (
          <Box padding={2}>
            <Alert
              variant="success"
              title={formatMessage(
                {
                  id: `${pluginId}.dialog.done`,
                  defaultMessage: "Translated to {locale}",
                },
                { locale: localeName(jobTargets[0].locale) }
              )}
              closeLabel={formatMessage({
                id: `${pluginId}.action.close`,
                defaultMessage: "Close",
              })}
              onClose={onClose}
            >
              {formatMessage({
                id: `${pluginId}.dialog.doneBody`,
                defaultMessage: "Reloading the editor in the new locale…",
              })}
            </Alert>
          </Box>
        )}
      </Modal.Body>

      <Modal.Footer>
        {phase === "pick" && (
          <Flex gap={2} justifyContent="flex-end" width="100%">
            <Button variant="tertiary" onClick={onClose}>
              {formatMessage({
                id: `${pluginId}.action.cancel`,
                defaultMessage: "Cancel",
              })}
            </Button>
            <Button
              startIcon={<Earth />}
              onClick={startTranslation}
              loading={starting || previewLoading}
              disabled={targets.length === 0 || starting || previewLoading}
            >
              {effectivePreview
                ? formatMessage({
                    id: `${pluginId}.action.startPreview`,
                    defaultMessage: "Generate preview",
                  })
                : targets.length > 1
                ? formatMessage(
                    {
                      id: `${pluginId}.action.startMulti`,
                      defaultMessage: "Translate to {count} locales",
                    },
                    { count: targets.length }
                  )
                : formatMessage({
                    id: `${pluginId}.action.start`,
                    defaultMessage: "Start translation",
                  })}
            </Button>
          </Flex>
        )}

        {phase === "running" && (
          <Flex gap={2} justifyContent="flex-end" width="100%">
            <Button
              variant="danger-light"
              onClick={requestCancel}
              disabled={cancelling}
            >
              {cancelling
                ? formatMessage({
                    id: `${pluginId}.action.cancelling`,
                    defaultMessage: "Cancelling…",
                  })
                : formatMessage({
                    id: `${pluginId}.action.cancel`,
                    defaultMessage: "Cancel",
                  })}
            </Button>
          </Flex>
        )}

        {phase === "preview" && (
          <Flex gap={2} justifyContent="flex-end" width="100%">
            <Button
              variant="tertiary"
              onClick={discardPreview}
              disabled={committingPreview}
            >
              {formatMessage({
                id: `${pluginId}.preview.discard`,
                defaultMessage: "Discard",
              })}
            </Button>
            <Button
              onClick={acceptPreview}
              loading={committingPreview}
              disabled={committingPreview}
            >
              {formatMessage({
                id: `${pluginId}.preview.accept`,
                defaultMessage: "Apply translation",
              })}
            </Button>
          </Flex>
        )}

        {phase === "summary" && (
          <Flex gap={2} justifyContent="flex-end" width="100%">
            {isSingleTargetCleanSuccess ? (
              <Button variant="tertiary" disabled>
                {formatMessage({
                  id: `${pluginId}.action.reloading`,
                  defaultMessage: "Reloading…",
                })}
              </Button>
            ) : (
              <Button onClick={onClose}>
                {formatMessage({
                  id: `${pluginId}.action.close`,
                  defaultMessage: "Close",
                })}
              </Button>
            )}
          </Flex>
        )}
      </Modal.Footer>
    </>
  );
};

const TranslateAction = ({ documentId, model, document }) => {
  const { formatMessage } = useIntl();

  const effectiveDocumentId = documentId || document?.documentId;
  const sourceLocale =
    (document && document.locale) ||
    (typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get(
          "plugins[i18n][locale]"
        )
      : null);

  if (!model || !effectiveDocumentId) return null;

  return {
    label: formatMessage({
      id: `${pluginId}.action.label`,
      defaultMessage: "Translate",
    }),
    icon: <Earth />,
    variant: "secondary",
    position: ["panel", "header"],
    dialog: {
      type: "modal",
      title: formatMessage({
        id: `${pluginId}.dialog.title`,
        defaultMessage: "Translate this entry",
      }),
      content: ({ onClose }) => (
        <TranslateModal
          onClose={onClose}
          model={model}
          documentId={effectiveDocumentId}
          sourceLocale={sourceLocale}
        />
      ),
    },
  };
};

export default TranslateAction;
