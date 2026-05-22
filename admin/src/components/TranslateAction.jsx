// Document Action that renders a "Translate" button in the Edit View dropdown.
// Opens a modal that walks through three phases:
//   pick     — choose one or more target locales and start a translation job
//   running  — live progress bar (polls GET /translate/jobs/:id) + per-target
//              checklist + cancel
//   summary  — terminal screen for done | partial | failed | cancelled, with
//              per-target outcomes and per-locale "Open" buttons
//
// A single job can fan out across multiple target locales; the backend
// processes them sequentially. If the user picked exactly one locale and it
// succeeded cleanly, we keep the prior UX of auto-reloading the editor in
// that locale (no extra click). Otherwise we stay on the source and let the
// user pick where to go next.

import React, { useEffect, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import { useFetchClient, useNotification } from "@strapi/strapi/admin";
import {
  Alert,
  Box,
  Button,
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
} from "@strapi/icons";
import pluginId from "../pluginId";

const POLL_INTERVAL_MS = 1000;

// User-facing names for the three internal format groups. The technical labels
// (plain/html/blocks) leak implementation detail; "Text / Rich text / Editor"
// matches what an editor actually thinks of these fields as.
const FORMAT_LABELS = {
  plain: "Text",
  html: "Rich text",
  blocks: "Editor",
};

// Per-state visual mapping for the per-target checklist.
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

const TranslateModal = ({ onClose, model, documentId, sourceLocale }) => {
  const { formatMessage } = useIntl();
  const { get, post } = useFetchClient();
  const { toggleNotification } = useNotification();

  const [phase, setPhase] = useState("pick");
  const [allLocales, setAllLocales] = useState([]);
  const [targets, setTargets] = useState([]);
  const [jobId, setJobId] = useState(null);
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const [cancelling, setCancelling] = useState(false);
  const [starting, setStarting] = useState(false);

  // Load locales once on mount.
  useEffect(() => {
    let cancelled = false;
    get(`/translate/locales`)
      .then((res) => {
        if (cancelled) return;
        setAllLocales(res.data || []);
      })
      .catch((err) => {
        if (!cancelled) {
          // eslint-disable-next-line no-console
          console.warn("[translate] could not fetch locales", err);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [get]);

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
        // Anything terminal moves us to the summary screen. The summary
        // distinguishes done / partial / failed / cancelled per-target.
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
        // Network blip during polling — keep trying. If the job genuinely
        // 404s (server restart), surface as failure.
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

  const sourceDisplayName = localeNameMap[sourceLocale] || sourceLocale || "current locale";

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

  // Per-active-target chunk progress (drives the "X/Y chunks" line + breakdown).
  const activeChunks = activeTarget
    ? sumProgress(activeTarget.progress)
    : { done: 0, total: 0 };

  // Overall percentage uses an equal-slice model: each target is 1/N of the
  // total bar; the currently-running one contributes its chunk fraction of
  // its slice. This stays stable as targets cycle (real chunk totals only
  // become known once a target starts).
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

  // Build the breakdown for the active target only (drops empty groups).
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

  // Summary counts (for the terminal screen alert).
  const doneCount = jobTargets.filter((t) => t.state === "done").length;
  const failedCount = jobTargets.filter((t) => t.state === "failed").length;
  const cancelledCount = jobTargets.filter((t) => t.state === "cancelled").length;
  const warningsCount = jobTargets.reduce(
    (sum, t) => sum + (t.result?.warnings?.length || 0),
    0
  );

  // Whether the prior "auto-reload into the new locale on success" UX applies.
  // Only when the user picked exactly one locale and it finished cleanly.
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

  // Auto-reload for the single-locale-clean-success path (preserves prior UX).
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

  // Toast on multi-locale completion (informational).
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

  const requestCancel = async () => {
    if (!jobId || cancelling) return;
    setCancelling(true);
    try {
      await post(`/translate/jobs/${jobId}/cancel`);
    } catch (err) {
      // Even if cancel fails (e.g. already-terminal), polling will surface
      // the final state.
      // eslint-disable-next-line no-console
      console.warn("[translate] cancel request failed", err);
    }
  };

  const selectAll = () =>
    setTargets(targetLocales.map((l) => l.code));
  const clearAll = () => setTargets([]);

  // ---------- Render helpers ----------

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

  // Summary-screen Alert variant + title.
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
        title: formatMessage(
          {
            id: `${pluginId}.summary.cancelled`,
            defaultMessage: "Translation cancelled",
          }
        ),
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
    // All done.
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
            totalTargets === 1
              ? "Translated to {count} locale"
              : "Translated to {count} locales",
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
            </Field.Root>
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
              loading={starting}
              disabled={targets.length === 0 || starting}
            >
              {targets.length > 1
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

  // Single-type URLs have no :id segment, so the router-derived `documentId`
  // is undefined. The loaded document object carries the real id — prefer it.
  const effectiveDocumentId = documentId || document?.documentId;

  // The current locale of the document being edited.
  const sourceLocale =
    (document && document.locale) ||
    (typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get(
          "plugins[i18n][locale]"
        )
      : null);

  // Hide the action on create-new flows (no document exists yet).
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
