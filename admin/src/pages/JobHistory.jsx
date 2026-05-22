// Job history page. Lists recent translation jobs from GET /translate/jobs.
//
// Auto-refreshes every 3s while any job is still in flight so editors can
// watch a job they started elsewhere progress, then drops the timer once
// everything is terminal to keep the page idle.

import React, { useEffect, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import {
  useFetchClient,
  useNotification,
  Layouts,
  Page,
} from "@strapi/strapi/admin";
import {
  Badge,
  Box,
  Button,
  Flex,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
  Typography,
} from "@strapi/design-system";
import { ArrowClockwise } from "@strapi/icons";
import pluginId from "../pluginId";

const tid = (key) => `${pluginId}.${key}`;
const POLL_INTERVAL_MS = 3000;

const stateInfo = {
  pending: { color: "neutral600", bg: "neutral150", defaultLabel: "Pending" },
  running: { color: "primary700", bg: "primary100", defaultLabel: "Running" },
  done: { color: "success700", bg: "success100", defaultLabel: "Done" },
  partial: { color: "warning700", bg: "warning100", defaultLabel: "Partial" },
  failed: { color: "danger700", bg: "danger100", defaultLabel: "Failed" },
  cancelled: { color: "neutral700", bg: "neutral150", defaultLabel: "Cancelled" },
};

const formatTimestamp = (ts) => {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
};

const formatDuration = (job) => {
  if (!job.startedAt) return "—";
  const end = job.finishedAt || Date.now();
  const ms = end - job.startedAt;
  if (ms < 1000) return "<1s";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
};

// Walk both the legacy top-level job.targets[] and the bulk nested
// job.documents[].targets[]. Bulk jobs only ever write warnings into the
// nested shape, so the previous top-level-only walk reported 0 for every
// bulk run.
const sumWarnings = (job) => {
  let n = 0;
  for (const t of job.targets || []) {
    n += t.result?.warnings?.length || 0;
  }
  for (const d of job.documents || []) {
    for (const t of d.targets || []) {
      n += t.result?.warnings?.length || 0;
    }
  }
  return n;
};

const JobHistoryPage = () => {
  const { formatMessage } = useIntl();
  const { get } = useFetchClient();
  const { toggleNotification } = useNotification();

  // Localised label for any server-side state enum, falling back to a
  // sensible default if a future state is added that we haven't translated.
  const stateLabel = (state) => {
    const info = stateInfo[state] || stateInfo.pending;
    return formatMessage({
      id: tid(`jobs.state.${state || "pending"}`),
      defaultMessage: info.defaultLabel,
    });
  };

  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchJobs = async () => {
    try {
      const res = await get("/translate/jobs?limit=100");
      setJobs(res.data?.jobs || []);
      setError(null);
    } catch (err) {
      setError(err?.message || "Failed to load");
      toggleNotification({
        type: "danger",
        message: formatMessage(
          {
            id: tid("jobs.toast.loadFailed"),
            defaultMessage: "Failed to load jobs: {error}",
          },
          { error: err?.message || "Unknown" }
        ),
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchJobs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasInflight = useMemo(
    () => jobs.some((j) => j.state === "pending" || j.state === "running"),
    [jobs]
  );

  useEffect(() => {
    if (!hasInflight) return undefined;
    const t = setInterval(() => fetchJobs(), POLL_INTERVAL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasInflight]);

  if (loading) {
    return (
      <Page.Main>
        <Page.Title>
          {formatMessage({
            id: tid("jobs.title"),
            defaultMessage: "Translation history",
          })}
        </Page.Title>
        <Page.Loading />
      </Page.Main>
    );
  }

  return (
    <Page.Main>
      <Page.Title>
        {formatMessage({
          id: tid("jobs.title"),
          defaultMessage: "Translation history",
        })}
      </Page.Title>
      <Layouts.Header
        title={formatMessage({
          id: tid("jobs.header.title"),
          defaultMessage: "Translation history",
        })}
        subtitle={formatMessage({
          id: tid("jobs.header.subtitle"),
          defaultMessage:
            "Recent translation jobs. Auto-refreshes while jobs are in flight.",
        })}
        primaryAction={
          <Button
            variant="tertiary"
            startIcon={<ArrowClockwise />}
            onClick={fetchJobs}
          >
            {formatMessage({
              id: tid("jobs.action.refresh"),
              defaultMessage: "Refresh",
            })}
          </Button>
        }
      />
      <Layouts.Content>
        {jobs.length === 0 ? (
          <Box
            padding={6}
            background="neutral0"
            hasRadius
            shadow="filterShadow"
            borderColor="neutral150"
          >
            <Typography variant="omega" textColor="neutral600">
              {formatMessage({
                id: tid("jobs.empty"),
                defaultMessage:
                  "No jobs in memory. Start translating from any entry and the run will appear here.",
              })}
            </Typography>
          </Box>
        ) : (
          <Box background="neutral0" hasRadius shadow="filterShadow">
            <Table colCount={7} rowCount={jobs.length + 1}>
              <Thead>
                <Tr>
                  <Th>
                    <Typography variant="sigma">
                      {formatMessage({
                        id: tid("jobs.col.state"),
                        defaultMessage: "State",
                      })}
                    </Typography>
                  </Th>
                  <Th>
                    <Typography variant="sigma">
                      {formatMessage({
                        id: tid("jobs.col.content"),
                        defaultMessage: "Content",
                      })}
                    </Typography>
                  </Th>
                  <Th>
                    <Typography variant="sigma">
                      {formatMessage({
                        id: tid("jobs.col.locales"),
                        defaultMessage: "Locales",
                      })}
                    </Typography>
                  </Th>
                  <Th>
                    <Typography variant="sigma">
                      {formatMessage({
                        id: tid("jobs.col.source"),
                        defaultMessage: "Source",
                      })}
                    </Typography>
                  </Th>
                  <Th>
                    <Typography variant="sigma">
                      {formatMessage({
                        id: tid("jobs.col.started"),
                        defaultMessage: "Started",
                      })}
                    </Typography>
                  </Th>
                  <Th>
                    <Typography variant="sigma">
                      {formatMessage({
                        id: tid("jobs.col.duration"),
                        defaultMessage: "Duration",
                      })}
                    </Typography>
                  </Th>
                  <Th>
                    <Typography variant="sigma">
                      {formatMessage({
                        id: tid("jobs.col.warnings"),
                        defaultMessage: "Warnings",
                      })}
                    </Typography>
                  </Th>
                </Tr>
              </Thead>
              <Tbody>
                {jobs.map((job) => {
                  const info = stateInfo[job.state] || stateInfo.pending;
                  return (
                    <Tr key={job.id}>
                      <Td>
                        <Badge
                          backgroundColor={info.bg}
                          textColor={info.color}
                          size="S"
                        >
                          {stateLabel(job.state)}
                        </Badge>
                      </Td>
                      <Td>
                        <Typography variant="omega" ellipsis>
                          {job.uid || "—"}
                        </Typography>
                        {job.documentId && (
                          <Typography variant="pi" textColor="neutral500">
                            {job.documentId.slice(0, 12)}…
                          </Typography>
                        )}
                      </Td>
                      <Td>
                        <Flex gap={1} wrap="wrap">
                          {targets.length === 0 && (
                            <Typography variant="pi" textColor="neutral500">
                              —
                            </Typography>
                          )}
                          {(job.targets || []).map((t) => {
                            const ti = stateInfo[t.state] || stateInfo.pending;
                            return (
                              <Badge
                                key={t.locale}
                                backgroundColor={ti.bg}
                                textColor={ti.color}
                                size="S"
                                title={stateLabel(t.state)}
                              >
                                {t.locale}
                              </Badge>
                            );
                          })}
                        </Flex>
                      </Td>
                      <Td>
                        <Typography variant="pi" textColor="neutral700">
                          {job.sourceLocale || "—"}
                        </Typography>
                        <Typography variant="pi" textColor="neutral500">
                          {job.source === "auto" ? "auto" : "manual"}
                        </Typography>
                      </Td>
                      <Td>
                        <Typography variant="pi">
                          {formatTimestamp(job.startedAt)}
                        </Typography>
                      </Td>
                      <Td>
                        <Typography variant="pi">{formatDuration(job)}</Typography>
                      </Td>
                      <Td>
                        {sumWarnings(job) > 0 ? (
                          <Typography variant="pi" textColor="warning700">
                            {sumWarnings(job)}
                          </Typography>
                        ) : (
                          <Typography variant="pi" textColor="neutral500">
                            —
                          </Typography>
                        )}
                      </Td>
                    </Tr>
                  );
                })}
              </Tbody>
            </Table>
          </Box>
        )}
        {error && (
          <Box paddingTop={3}>
            <Typography variant="pi" textColor="danger600">
              {error}
            </Typography>
          </Box>
        )}
      </Layouts.Content>
    </Page.Main>
  );
};

export default JobHistoryPage;
