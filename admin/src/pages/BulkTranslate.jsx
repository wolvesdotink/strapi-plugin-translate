// Bulk translation page. Lets an admin translate every document of one
// content type into one or many target locales in a single job.
//
// Flow:
//   1. Pick a content type (from GET /translate/content-types).
//   2. Pick a source locale.
//   3. Pick target locales (any locale ≠ source).
//   4. Optionally narrow to selected documents (defaults to all in source locale).
//   5. Start a /translate/bulk job, then poll for progress.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import {
  useFetchClient,
  useNotification,
  Layouts,
  Page,
} from "@strapi/strapi/admin";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Field,
  Flex,
  MultiSelect,
  MultiSelectOption,
  ProgressBar,
  SingleSelect,
  SingleSelectOption,
  Typography,
} from "@strapi/design-system";
import { Earth } from "@strapi/icons";
import pluginId from "../pluginId";

const tid = (key) => `${pluginId}.${key}`;
const POLL_INTERVAL_MS = 1500;
const DOCS_PAGE_SIZE = 200;
const DOCS_HARD_CAP = 5000;
const TERMINAL_JOB_STATES = new Set(["done", "failed", "cancelled", "partial"]);

// Localised label for a server-side job state. The server returns the raw
// enum; the UI is responsible for translation.
const useStateLabel = (formatMessage) => (state) =>
  formatMessage(
    {
      id: `${pluginId}.jobs.state.${state || "pending"}`,
      defaultMessage:
        state === "running"
          ? "Running"
          : state === "done"
          ? "Done"
          : state === "failed"
          ? "Failed"
          : state === "cancelled"
          ? "Cancelled"
          : state === "partial"
          ? "Partial"
          : "Pending",
    }
  );

const BulkTranslatePage = () => {
  const { formatMessage } = useIntl();
  const { get, post } = useFetchClient();
  const { toggleNotification } = useNotification();

  const [contentTypes, setContentTypes] = useState([]);
  const [allLocales, setAllLocales] = useState([]);

  const [selectedUid, setSelectedUid] = useState("");
  const [sourceLocale, setSourceLocale] = useState("");
  const [targetLocales, setTargetLocales] = useState([]);

  const [documents, setDocuments] = useState([]);
  const [docsTruncated, setDocsTruncated] = useState(false);
  const [selectedDocs, setSelectedDocs] = useState(new Set());
  const [docsLoading, setDocsLoading] = useState(false);
  const [docsError, setDocsError] = useState(null);

  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [jobId, setJobId] = useState(null);
  const [job, setJob] = useState(null);

  const stateLabel = useStateLabel(formatMessage);

  // Initial load: locales + content types in parallel.
  useEffect(() => {
    Promise.all([
      get("/translate/locales").then((r) => r.data || []).catch(() => []),
      get("/translate/content-types")
        .then((r) => r.data?.contentTypes || [])
        .catch((err) => {
          toggleNotification({
            type: "danger",
            message: formatMessage(
              {
                id: tid("bulk.toast.loadFailed"),
                defaultMessage: "Failed to load content types: {error}",
              },
              { error: err?.message || "Unknown" }
            ),
          });
          return [];
        }),
    ]).then(([locales, cts]) => {
      setAllLocales(locales);
      setContentTypes(cts);
      const def = locales.find((l) => l.isDefault);
      if (def) setSourceLocale(def.code);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load document list whenever uid+source changes. Pages through the
  // content-list endpoint so collections >DOCS_PAGE_SIZE aren't silently
  // truncated; bails at DOCS_HARD_CAP to keep the picker responsive on
  // very large collections (surfaces a "truncated" banner in that case).
  useEffect(() => {
    if (!selectedUid || !sourceLocale) {
      setDocuments([]);
      setSelectedDocs(new Set());
      setDocsError(null);
      setDocsTruncated(false);
      return undefined;
    }
    let cancelled = false;
    setDocsLoading(true);
    setDocsError(null);
    setDocsTruncated(false);
    (async () => {
      const acc = [];
      let start = 0;
      try {
        while (!cancelled) {
          const res = await post("/translate/content/list", {
            uid: selectedUid,
            sourceLocale,
            limit: DOCS_PAGE_SIZE,
            start,
          });
          const batch = res.data?.documents || [];
          acc.push(...batch);
          start += batch.length;
          if (batch.length < DOCS_PAGE_SIZE) break;
          if (acc.length >= DOCS_HARD_CAP) {
            if (!cancelled) setDocsTruncated(true);
            break;
          }
        }
        if (cancelled) return;
        setDocuments(acc);
        setSelectedDocs(new Set(acc.map((d) => d.documentId)));
      } catch (err) {
        if (cancelled) return;
        setDocuments([]);
        setSelectedDocs(new Set());
        setDocsError(
          err?.response?.data?.error?.message ||
            err?.message ||
            "Failed to load documents"
        );
      } finally {
        if (!cancelled) setDocsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedUid, sourceLocale, post]);

  // Poll job state while bulk job is running. Use a ref to read terminal
  // status without putting `job` in the dep array — otherwise every setJob
  // would tear down the interval and immediately re-fire tick(), turning a
  // 1.5s poll into an immediate-poll loop.
  const jobStateRef = useRef(null);
  useEffect(() => {
    jobStateRef.current = job?.state || null;
  }, [job]);
  useEffect(() => {
    if (!jobId) return undefined;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      if (jobStateRef.current && TERMINAL_JOB_STATES.has(jobStateRef.current)) {
        return;
      }
      try {
        const res = await get(`/translate/jobs/${jobId}`);
        if (stopped) return;
        setJob(res.data);
      } catch {
        /* will retry on next interval */
      }
    };
    tick();
    const t = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [jobId, get]);

  const targetLocaleOptions = useMemo(
    () => allLocales.filter((l) => l.code !== sourceLocale),
    [allLocales, sourceLocale]
  );
  const localeNameMap = useMemo(() => {
    const m = {};
    for (const l of allLocales) m[l.code] = l.name;
    return m;
  }, [allLocales]);
  const localeName = (code) => localeNameMap[code] || code;

  // Drop selected targets if the source locale changes to match one of them.
  useEffect(() => {
    setTargetLocales((cur) => cur.filter((c) => c !== sourceLocale));
  }, [sourceLocale]);

  const selectedDoc = contentTypes.find((c) => c.uid === selectedUid);

  const totalUnits = selectedDocs.size * targetLocales.length;

  const startBulk = async () => {
    if (!selectedUid) return;
    if (selectedDocs.size === 0) {
      toggleNotification({
        type: "warning",
        message: formatMessage({
          id: tid("bulk.toast.pickDocs"),
          defaultMessage: "Pick at least one document.",
        }),
      });
      return;
    }
    if (targetLocales.length === 0) {
      toggleNotification({
        type: "warning",
        message: formatMessage({
          id: tid("bulk.toast.pickLocales"),
          defaultMessage: "Pick at least one target locale.",
        }),
      });
      return;
    }
    setStarting(true);
    setJob(null);
    setJobId(null);
    try {
      const res = await post("/translate/bulk", {
        uid: selectedUid,
        documentIds: [...selectedDocs],
        sourceLocale,
        targetLocales,
      });
      setJobId(res.data.jobId);
    } catch (err) {
      toggleNotification({
        type: "danger",
        message: formatMessage(
          {
            id: tid("bulk.toast.startFailed"),
            defaultMessage: "Bulk translation failed: {error}",
          },
          {
            error:
              err?.response?.data?.error?.message ||
              err?.message ||
              "Unknown error",
          }
        ),
      });
    } finally {
      setStarting(false);
    }
  };

  const cancelBulk = async () => {
    if (!jobId) return;
    setCancelling(true);
    try {
      await post(`/translate/jobs/${jobId}/cancel`);
    } catch {
      // Reset on POST failure so the user can retry; on success leave
      // `cancelling` true and let the next poll (which observes a terminal
      // job state) drive the UI back to its post-run state.
      setCancelling(false);
    }
  };

  // Per-doc + overall progress derived from the job snapshot.
  const docs = job?.documents || [];
  const doneDocs = docs.filter((d) => d.state === "done").length;
  const failedDocs = docs.filter((d) => d.state === "failed").length;
  const overallPct =
    docs.length > 0 ? Math.round((doneDocs / docs.length) * 100) : 0;

  // Treat "started but no snapshot yet" and "starting in-flight" as inflight
  // so the Start button doesn't briefly re-enable between the 202 response
  // and the first poll result (which would let an impatient user double-fire
  // the job).
  const inflight =
    starting ||
    (jobId && (!job || !TERMINAL_JOB_STATES.has(job.state)));

  return (
    <Page.Main>
      <Page.Title>
        {formatMessage({
          id: tid("bulk.title"),
          defaultMessage: "Bulk translate",
        })}
      </Page.Title>
      <Layouts.Header
        title={formatMessage({
          id: tid("bulk.header.title"),
          defaultMessage: "Bulk translate",
        })}
        subtitle={formatMessage({
          id: tid("bulk.header.subtitle"),
          defaultMessage:
            "Translate every document of one content type into one or many target locales.",
        })}
      />
      <Layouts.Content>
        <Flex direction="column" alignItems="stretch" gap={6}>
          <Box
            background="neutral0"
            padding={6}
            shadow="filterShadow"
            hasRadius
            borderColor="neutral150"
          >
            <Flex direction="column" alignItems="stretch" gap={4}>
              <Typography variant="delta" tag="h2">
                {formatMessage({
                  id: tid("bulk.scope.title"),
                  defaultMessage: "Scope",
                })}
              </Typography>

              <Field.Root name="content-type">
                <Field.Label>
                  {formatMessage({
                    id: tid("bulk.contentType"),
                    defaultMessage: "Content type",
                  })}
                </Field.Label>
                <SingleSelect
                  value={selectedUid}
                  onChange={(v) => setSelectedUid(String(v))}
                  placeholder={formatMessage({
                    id: tid("bulk.contentType.placeholder"),
                    defaultMessage: "Select a content type",
                  })}
                  disabled={inflight}
                >
                  {contentTypes.map((c) => (
                    <SingleSelectOption key={c.uid} value={c.uid}>
                      {c.displayName} ({c.uid})
                    </SingleSelectOption>
                  ))}
                </SingleSelect>
                {selectedDoc && (
                  <Field.Hint>
                    {formatMessage(
                      {
                        id: tid("bulk.contentType.hint"),
                        defaultMessage:
                          "{count} translatable field(s) walked on each document.",
                      },
                      { count: selectedDoc.translatableFieldCount }
                    )}
                  </Field.Hint>
                )}
              </Field.Root>

              <Flex gap={4} alignItems="flex-start">
                <Box flex="1">
                  <Field.Root name="source-locale">
                    <Field.Label>
                      {formatMessage({
                        id: tid("bulk.sourceLocale"),
                        defaultMessage: "Source locale",
                      })}
                    </Field.Label>
                    <SingleSelect
                      value={sourceLocale}
                      onChange={(v) => setSourceLocale(String(v))}
                      disabled={inflight}
                    >
                      {allLocales.map((l) => (
                        <SingleSelectOption key={l.code} value={l.code}>
                          {l.name} ({l.code})
                        </SingleSelectOption>
                      ))}
                    </SingleSelect>
                  </Field.Root>
                </Box>
                <Box flex="2">
                  <Field.Root name="target-locales">
                    <Field.Label>
                      {formatMessage({
                        id: tid("bulk.targetLocales"),
                        defaultMessage: "Target locales",
                      })}
                    </Field.Label>
                    <MultiSelect
                      value={targetLocales}
                      onChange={(v) =>
                        setTargetLocales(Array.isArray(v) ? v.map(String) : [])
                      }
                      placeholder={formatMessage({
                        id: tid("bulk.targetLocales.placeholder"),
                        defaultMessage: "Select one or more locales",
                      })}
                      disabled={inflight || !targetLocaleOptions.length}
                      withTags
                    >
                      {targetLocaleOptions.map((l) => (
                        <MultiSelectOption key={l.code} value={l.code}>
                          {l.name} ({l.code})
                        </MultiSelectOption>
                      ))}
                    </MultiSelect>
                  </Field.Root>
                </Box>
              </Flex>
            </Flex>
          </Box>

          {selectedUid && (
            <Box
              background="neutral0"
              padding={6}
              shadow="filterShadow"
              hasRadius
              borderColor="neutral150"
            >
              <Flex direction="column" alignItems="stretch" gap={4}>
                <Flex justifyContent="space-between" alignItems="center">
                  <Typography variant="delta" tag="h2">
                    {formatMessage({
                      id: tid("bulk.docs.title"),
                      defaultMessage: "Documents",
                    })}
                  </Typography>
                  <Flex gap={2}>
                    <Button
                      variant="tertiary"
                      size="S"
                      onClick={() =>
                        setSelectedDocs(new Set(documents.map((d) => d.documentId)))
                      }
                      disabled={inflight || !documents.length}
                    >
                      {formatMessage({
                        id: tid("bulk.docs.selectAll"),
                        defaultMessage: "Select all",
                      })}
                    </Button>
                    <Button
                      variant="tertiary"
                      size="S"
                      onClick={() => setSelectedDocs(new Set())}
                      disabled={inflight || !selectedDocs.size}
                    >
                      {formatMessage({
                        id: tid("bulk.docs.clear"),
                        defaultMessage: "Clear",
                      })}
                    </Button>
                  </Flex>
                </Flex>
                {docsLoading ? (
                  <Typography variant="pi" textColor="neutral500">
                    {formatMessage({
                      id: tid("bulk.docs.loading"),
                      defaultMessage: "Loading documents…",
                    })}
                  </Typography>
                ) : docsError ? (
                  <Alert
                    variant="danger"
                    title={formatMessage({
                      id: tid("bulk.docs.errorTitle"),
                      defaultMessage: "Could not load documents",
                    })}
                    closeLabel=""
                  >
                    {docsError}
                  </Alert>
                ) : documents.length === 0 ? (
                  <Typography variant="pi" textColor="neutral500">
                    {formatMessage({
                      id: tid("bulk.docs.empty"),
                      defaultMessage:
                        "No documents found for this content type in the chosen source locale.",
                    })}
                  </Typography>
                ) : (
                  <Box style={{ maxHeight: 320, overflowY: "auto" }}>
                    <Flex direction="column" alignItems="stretch" gap={1}>
                      {documents.map((d) => (
                        <Flex
                          key={d.documentId}
                          gap={2}
                          alignItems="center"
                          padding={2}
                          background={
                            selectedDocs.has(d.documentId)
                              ? "primary100"
                              : "neutral0"
                          }
                          hasRadius
                          borderColor={
                            selectedDocs.has(d.documentId)
                              ? "primary200"
                              : "neutral200"
                          }
                          borderWidth="1px"
                          borderStyle="solid"
                        >
                          <Checkbox
                            checked={selectedDocs.has(d.documentId)}
                            onCheckedChange={(v) => {
                              setSelectedDocs((cur) => {
                                const next = new Set(cur);
                                if (v) next.add(d.documentId);
                                else next.delete(d.documentId);
                                return next;
                              });
                            }}
                            disabled={inflight}
                          />
                          <Box flex="1">
                            <Typography variant="omega">{d.label}</Typography>
                            <Typography variant="pi" textColor="neutral500">
                              {d.documentId}
                            </Typography>
                          </Box>
                        </Flex>
                      ))}
                    </Flex>
                  </Box>
                )}
                <Typography variant="pi" textColor="neutral600">
                  {formatMessage(
                    {
                      id: tid("bulk.docs.summary"),
                      defaultMessage:
                        "{selected} of {total} selected — {units} translation(s) will run.",
                    },
                    {
                      selected: selectedDocs.size,
                      total: documents.length,
                      units: totalUnits,
                    }
                  )}
                </Typography>
                {docsTruncated && (
                  <Typography variant="pi" textColor="warning700">
                    {formatMessage(
                      {
                        id: tid("bulk.docs.truncated"),
                        defaultMessage:
                          "Showing the first {cap} documents — refine the source locale or split the run to translate the rest.",
                      },
                      { cap: DOCS_HARD_CAP }
                    )}
                  </Typography>
                )}
              </Flex>
            </Box>
          )}

          {job && (
            <Box
              background="neutral0"
              padding={6}
              shadow="filterShadow"
              hasRadius
              borderColor="neutral150"
            >
              <Flex direction="column" alignItems="stretch" gap={4}>
                <Flex justifyContent="space-between" alignItems="baseline">
                  <Typography variant="delta" tag="h2">
                    {formatMessage({
                      id: tid("bulk.run.title"),
                      defaultMessage: "Progress",
                    })}
                  </Typography>
                  <Typography
                    variant="alpha"
                    textColor="primary700"
                    fontWeight="bold"
                  >
                    {overallPct}%
                  </Typography>
                </Flex>
                <ProgressBar value={overallPct} max={100} size="M" />
                <Typography variant="pi" textColor="neutral600">
                  {formatMessage(
                    {
                      id: tid("bulk.run.status"),
                      defaultMessage:
                        "{state}: {done} done · {failed} failed · {total} total",
                    },
                    {
                      state: stateLabel(job.state),
                      done: doneDocs,
                      failed: failedDocs,
                      total: docs.length,
                    }
                  )}
                </Typography>
                {!inflight && job.state === "done" && (
                  <Alert
                    variant="success"
                    title={formatMessage({
                      id: tid("bulk.run.done"),
                      defaultMessage: "Bulk translation complete",
                    })}
                    closeLabel=""
                  >
                    {formatMessage(
                      {
                        id: tid("bulk.run.doneBody"),
                        defaultMessage:
                          "{count} document(s) translated successfully.",
                      },
                      { count: doneDocs }
                    )}
                  </Alert>
                )}
              </Flex>
            </Box>
          )}
        </Flex>
      </Layouts.Content>
      <Layouts.Footer />
      <Box
        background="neutral0"
        padding={4}
        borderColor="neutral150"
        borderWidth="1px"
        borderStyle="solid"
        style={{
          position: "sticky",
          bottom: 0,
          marginTop: "1rem",
        }}
      >
        <Flex justifyContent="flex-end" gap={2}>
          {inflight ? (
            <Button
              variant="danger-light"
              onClick={cancelBulk}
              disabled={cancelling}
            >
              {cancelling
                ? formatMessage({
                    id: tid("bulk.action.cancelling"),
                    defaultMessage: "Cancelling…",
                  })
                : formatMessage({
                    id: tid("bulk.action.cancel"),
                    defaultMessage: "Cancel job",
                  })}
            </Button>
          ) : (
            <Button
              startIcon={<Earth />}
              onClick={startBulk}
              loading={starting}
              disabled={
                starting ||
                !selectedUid ||
                selectedDocs.size === 0 ||
                targetLocales.length === 0
              }
            >
              {formatMessage(
                {
                  id: tid("bulk.action.start"),
                  defaultMessage:
                    "Start bulk translation ({units} run(s))",
                },
                { units: totalUnits }
              )}
            </Button>
          )}
        </Flex>
      </Box>
    </Page.Main>
  );
};

export default BulkTranslatePage;
