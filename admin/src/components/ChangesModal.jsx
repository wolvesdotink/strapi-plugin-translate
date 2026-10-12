import React, { useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { useFetchClient } from "@strapi/strapi/admin";
import {
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  Flex,
  Modal,
  SingleSelect,
  SingleSelectOption,
  Typography,
} from "@strapi/design-system";
import pluginId from "../pluginId";

const message = (error) =>
  error?.response?.data?.error?.message ||
  error.message ||
  "Translation failed";
const value = (v) =>
  v == null ? "—" : typeof v === "string" ? v : JSON.stringify(v, null, 2);

export function ChangesModal({
  open,
  onClose,
  model,
  documentId,
  sourceLocale,
  changes,
  onApplied,
  onRefresh,
}) {
  const { formatMessage } = useIntl();
  const t = (key, fallback, values) =>
    formatMessage(
      { id: `${pluginId}.changes.${key}`, defaultMessage: fallback },
      values,
    );
  const { get, post } = useFetchClient();
  const [locales, setLocales] = useState([]),
    [targets, setTargets] = useState([]);
  const [modules, setModules] = useState([]),
    [linked, setLinked] = useState(false),
    [initial, setInitial] = useState(false);
  const [phase, setPhase] = useState("pick"),
    [job, setJob] = useState(null),
    [jobId, setJobId] = useState(null);
  const [active, setActive] = useState(null),
    [error, setError] = useState(null),
    [busy, setBusy] = useState(false);
  const [excluded, setExcluded] = useState({}),
    [omit, setOmit] = useState({}),
    [alignments, setAlignments] = useState({});
  const [applied, setApplied] = useState({});
  const [estimate, setEstimate] = useState(null),
    [estimateError, setEstimateError] = useState(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  useEffect(() => {
    if (!open) return;
    let current = true;
    setPhase("pick");
    setError(null);
    setJob(null);
    setJobId(null);
    setApplied({});
    setModules((changes?.modules || []).map((m) => m.key));
    get("/translate/locales")
      .then(({ data }) => {
        if (!current) return;
        const options = data.filter(
          (l) =>
            l.code !== sourceLocale &&
            (!changes.targetLocales || changes.targetLocales.includes(l.code)),
        );
        setLocales(options);
        let last = [];
        try {
          last = JSON.parse(
            localStorage.getItem(`translate:changes:${model}`) || "[]",
          );
        } catch {
          /* unavailable */
        }
        setTargets(last.filter((code) => options.some((l) => l.code === code)));
      })
      .catch((err) => current && setError(message(err)));
    return () => {
      current = false;
    };
  }, [open, sourceLocale, model]);

  useEffect(() => {
    if (!jobId || phase !== "running") return;
    let cancelled = false,
      timer;
    const poll = async () => {
      try {
        const { data } = await get(`/translate/jobs/${jobId}`);
        if (cancelled) return;
        setJob(data);
        if (["done", "partial", "failed", "cancelled"].includes(data.state)) {
          setPhase("review");
          setActive(
            data.targets.find((target) => target.state === "done")?.locale ||
              data.targets[0]?.locale,
          );
        } else timer = setTimeout(poll, 900);
      } catch (err) {
        if (!cancelled) {
          setError(message(err));
          setPhase("pick");
        }
      }
    };
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [jobId, phase, get]);

  useEffect(() => {
    if (phase !== "pick" || !targets.length || !modules.length) {
      setEstimate(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const { data } = await post("/translate/estimate", {
          mode: "changes",
          uid: model,
          documentId,
          sourceLocale,
          targetLocales: targets,
          moduleKeys: modules,
          revision: changes.revision,
          initialTranslation: initial,
          translateLinkedItems: linked,
          alignments,
        });
        if (!cancelled) {
          setEstimate(data);
          setEstimateError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setEstimate(null);
          setEstimateError(message(err));
        }
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    phase,
    targets,
    modules,
    initial,
    linked,
    model,
    documentId,
    sourceLocale,
    changes.revision,
    post,
    alignments,
  ]);

  useEffect(() => {
    if (!open || phase !== "pick") return;
    const current = (changes.modules || []).map((module) => module.key);
    setModules((previous) => {
      const kept = previous.filter((key) => current.includes(key));
      return kept.length ? kept : current;
    });
  }, [changes.revision]);

  const start = async () => {
    if (!targets.length || (!modules.length && !initial)) return;
    setBusy(true);
    setError(null);
    setExcluded({});
    setOmit({});
    try {
      try {
        localStorage.setItem(
          `translate:changes:${model}`,
          JSON.stringify(targets),
        );
      } catch {
        /* unavailable */
      }
      const { data } = await post("/translate/preview", {
        mode: "changes",
        uid: model,
        documentId,
        sourceLocale,
        targetLocales: targets,
        revision: changes.revision,
        moduleKeys: modules,
        translateLinkedItems: linked,
        initialTranslation: initial,
        alignments,
      });
      setJobId(data.jobId);
      setJob(null);
      setPhase("running");
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };
  const toggle = (setter, key, checked) =>
    setter((current) =>
      checked ? [...current, key] : current.filter((item) => item !== key),
    );
  const toggleField = (id, checked, previewId) =>
    setExcluded((current) => ({
      ...current,
      [previewId]: { ...current[previewId], [id]: !checked },
    }));
  const target = job?.targets?.find((item) => item.locale === active);
  const preview = target?.state === "done" ? target.result : null;
  const unresolved = (preview?.relations || []).filter(
    (r) =>
      !excluded[preview?.previewId]?.[r.fieldKey] &&
      r.status === "missing" &&
      !preview?.children?.some(
        (c) => c.uid === r.uid && c.documentId === r.documentId,
      ),
  );
  const blocked =
    unresolved.some((r) => r.required) ||
    (unresolved.length > 0 && !omit[preview?.previewId]);
  const accept = async () => {
    if (!preview || blocked) return;
    setBusy(true);
    setError(null);
    try {
      const { data } = await post(
        `/translate/preview/${preview.previewId}/accept`,
        {
          excludedOperations: Object.keys(
            excluded[preview.previewId] || {},
          ).filter((id) => excluded[preview.previewId][id]),
          childExcludedOperations: Object.fromEntries(
            (preview.children || []).map((c) => [
              c.previewId,
              Object.keys(excluded[c.previewId] || {}).filter(
                (id) => excluded[c.previewId][id],
              ),
            ]),
          ),
          allowMissingRelations: !!omit[preview.previewId],
        },
      );
      if (!mounted.current) return;
      setApplied((current) => ({ ...current, [active]: data }));
      onApplied?.();
    } catch (err) {
      const revised = err?.response?.data?.error?.details?.preview;
      if (revised)
        setJob((current) => ({
          ...current,
          targets: current.targets.map((target) =>
            target.locale === active ? { ...target, result: revised } : target,
          ),
        }));
      setError(message(err));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const close = async () => {
    if (busy) return;
    if (phase === "running" && jobId)
      await post(`/translate/jobs/${jobId}/cancel`).catch(() => {});
    for (const item of job?.targets || []) {
      if (item.result?.previewId && !applied[item.locale])
        await post(`/translate/preview/${item.result.previewId}/discard`).catch(
          () => {},
        );
    }
    onClose();
  };

  const renderModules = (row, child = false) => (
    <Flex direction="column" alignItems="stretch" gap={4}>
      {child && (
        <Typography variant="delta">
          {t("linkedItem", "Linked item")} · {row.label} · {row.targetLocale}
        </Typography>
      )}
      {(row.modules || []).map((module) => (
        <Box
          key={module.key}
          padding={4}
          background="neutral100"
          borderColor="neutral200"
          hasRadius
        >
          <Flex
            justifyContent="space-between"
            gap={3}
            wrap="wrap"
            marginBottom={3}
          >
            <Typography variant="delta">{module.label}</Typography>
            <Badge>
              {t("changedFields", "{count} changes", {
                count: module.fields.length,
              })}
            </Badge>
          </Flex>
          <Typography variant="pi" textColor="neutral600">
            {module.sourcePath
              .split(".")
              .map((part) =>
                /^\d+$/.test(part) ? `[${Number(part) + 1}]` : part,
              )
              .join(" › ")}
          </Typography>
          {module.fields.map((field) => (
            <Box key={field.id} marginTop={4}>
              <Checkbox
                checked={
                  !excluded[row.previewId]?.[field.operationId || field.id]
                }
                onCheckedChange={(checked) =>
                  toggleField(
                    field.operationId || field.id,
                    checked,
                    row.previewId,
                  )
                }
                disabled={
                  busy ||
                  !!applied[active] ||
                  row.initialTranslation ||
                  field.kind === "inserted-field"
                }
              >
                {field.name}{" "}
                {field.kind === "structure"
                  ? `· ${t("structure", "module structure")}`
                  : ""}
              </Checkbox>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns:
                    "repeat(auto-fit, minmax(min(100%, 210px), 1fr))",
                  gap: 12,
                  marginTop: 12,
                }}
              >
                {[
                  [t("source", "Saved source"), field.source],
                  [t("current", "Current translation"), field.before],
                  [t("proposed", "Proposed translation"), field.after],
                ].map(([label, content]) => (
                  <Box key={label} padding={3} background="neutral0" hasRadius>
                    <Typography variant="pi" textColor="neutral600">
                      {label}
                    </Typography>
                    <Typography
                      as="pre"
                      variant="omega"
                      style={{
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        marginTop: 8,
                        fontFamily: "inherit",
                      }}
                    >
                      {value(content)}
                    </Typography>
                  </Box>
                ))}
              </div>
            </Box>
          ))}
        </Box>
      ))}
      {(row.relations || []).map((relation, index) => (
        <Box
          key={`${relation.path}:${index}`}
          padding={3}
          hasRadius
          background={
            relation.status === "missing" ? "warning100" : "neutral100"
          }
        >
          <Typography fontWeight="bold">
            {relation.label} · {relation.targetLocale}
          </Typography>
          <br />
          <Typography variant="pi">
            {relation.path} ·{" "}
            {relation.status === "missing"
              ? t("missing", "No localized item yet")
              : relation.status === "draft-only"
                ? t("draftOnly", "Localized item exists as a draft")
                : t("available", "Localized item available")}
          </Typography>
        </Box>
      ))}
    </Flex>
  );

  return (
    <Modal.Root open={open} onOpenChange={(isOpen) => !isOpen && close()}>
      <Modal.Content style={{ maxWidth: 1040, width: "calc(100vw - 32px)" }}>
        <Modal.Header>
          <Modal.Title>{t("title", "Translate saved changes")}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Flex direction="column" alignItems="stretch" gap={5}>
            {error && (
              <Alert
                variant="danger"
                title={t("error", "Translation needs attention")}
              >
                {error}
              </Alert>
            )}
            {phase === "pick" && (
              <>
                <Typography>
                  {t(
                    "intro",
                    "Your page is saved. Choose which modules and languages to update. Unchanged translations are preserved.",
                  )}
                </Typography>
                <Typography variant="delta">
                  {t("modules", "Changed modules")}
                </Typography>
                {(changes?.modules || []).map((module) => (
                  <Box
                    key={module.key}
                    padding={3}
                    background="neutral100"
                    hasRadius
                  >
                    <Checkbox
                      checked={modules.includes(module.key)}
                      onCheckedChange={(checked) =>
                        toggle(setModules, module.key, checked)
                      }
                    >
                      {module.label} ·{" "}
                      {module.fields.map((field) => field.name).join(", ")}
                    </Checkbox>
                  </Box>
                ))}
                <Typography variant="delta">
                  {t("languages", "Translate into")}
                </Typography>
                <Flex wrap="wrap" gap={5}>
                  {locales.map((locale) => (
                    <Checkbox
                      key={locale.code}
                      checked={targets.includes(locale.code)}
                      onCheckedChange={(checked) =>
                        toggle(setTargets, locale.code, checked)
                      }
                    >
                      {locale.name || locale.code}
                    </Checkbox>
                  ))}
                </Flex>
                {estimate && (
                  <Typography variant="pi" textColor="neutral600">
                    {t(
                      "estimate",
                      "Estimated scope: {input} input tokens + {output} output tokens",
                      {
                        input: estimate.inputTokens,
                        output: estimate.estimatedOutputTokens,
                      },
                    )}
                    {estimate.estimatedCostUsd != null
                      ? ` · $${estimate.estimatedCostUsd.toFixed(3)}`
                      : ""}
                  </Typography>
                )}
                {estimateError && (
                  <Typography variant="pi" textColor="warning700">
                    {t("estimateUnavailable", "Estimate unavailable")}:{" "}
                    {estimateError}
                  </Typography>
                )}
                <Checkbox checked={linked} onCheckedChange={setLinked}>
                  {t(
                    "linked",
                    "Also translate pending changes to linked items",
                  )}
                </Checkbox>
                <Typography variant="pi" textColor="neutral600">
                  {t(
                    "linkedHelp",
                    "Existing localized items are linked automatically. Selecting this option adds separate previews for changed articles and missing translations.",
                  )}
                </Typography>
                <Checkbox checked={initial} onCheckedChange={setInitial}>
                  {t(
                    "initial",
                    "Create missing page languages with an initial full translation",
                  )}
                </Checkbox>
                <Typography variant="pi" textColor="neutral600">
                  {t(
                    "draftHelp",
                    "Draft content stays unpublished. For content types without drafts, applying changes updates live content.",
                  )}
                </Typography>
              </>
            )}
            {phase === "running" && (
              <>
                <Typography variant="delta">
                  {t("generating", "Generating module previews…")}
                </Typography>
                {(
                  job?.targets ||
                  targets.map((locale) => ({ locale, state: "pending" }))
                ).map((item) => (
                  <Typography key={item.locale}>
                    {item.locale} · {item.state}
                  </Typography>
                ))}
              </>
            )}
            {phase === "review" && (
              <>
                <Flex wrap="wrap" gap={2}>
                  {job?.targets.map((item) => (
                    <Button
                      key={item.locale}
                      variant={active === item.locale ? "default" : "secondary"}
                      onClick={() => {
                        setActive(item.locale);
                        setError(null);
                      }}
                    >
                      {locales.find((l) => l.code === item.locale)?.name ||
                        item.locale}
                      {applied[item.locale] ? " ✓" : ""}
                    </Button>
                  ))}
                </Flex>
                {applied[active] ? (
                  <Alert
                    variant="success"
                    title={t("applied", "Changes applied")}
                  >
                    {t(
                      "appliedHelp",
                      "The approved changes are saved. Publication remains a separate action for draft content.",
                    )}
                  </Alert>
                ) : preview ? (
                  <>
                    {preview.initialTranslation && (
                      <Alert
                        variant="warning"
                        title={t("initialPreview", "Initial full translation")}
                      >
                        {t(
                          "initialHelp",
                          "This language has no page yet. Review the complete initial translation before creating it.",
                        )}
                      </Alert>
                    )}
                    {renderModules(preview)}
                    {(preview.children || []).map((child) => (
                      <Box key={child.previewId} paddingTop={4}>
                        {renderModules(child, true)}
                      </Box>
                    ))}
                    {!!unresolved.length && (
                      <Alert
                        variant="warning"
                        title={t(
                          "missingLinks",
                          "Some linked items need a translation",
                        )}
                      >
                        {t(
                          "missingHelp",
                          "Generate again with linked-item translation enabled, or omit optional links. Required missing links must be resolved.",
                        )}
                      </Alert>
                    )}
                    {unresolved.length > 0 &&
                      !unresolved.some((r) => r.required) && (
                        <Checkbox
                          checked={!!omit[preview.previewId]}
                          onCheckedChange={(checked) =>
                            setOmit((current) => ({
                              ...current,
                              [preview.previewId]: checked,
                            }))
                          }
                        >
                          {t(
                            "omit",
                            "Omit these optional links in this language",
                          )}
                        </Checkbox>
                      )}
                  </>
                ) : (
                  <>
                    <Alert
                      variant="warning"
                      title={t("failed", "Preview could not be generated")}
                    >
                      {target?.error || job?.error}
                    </Alert>
                    {(target?.result?.details?.alignments || []).map((row) => (
                      <Box
                        key={row.sourceKey}
                        padding={3}
                        background="neutral100"
                        hasRadius
                      >
                        <Typography>
                          {row.label} · {row.sourcePath}
                        </Typography>
                        <SingleSelect
                          placeholder={t(
                            "match",
                            "Choose the corresponding translated module",
                          )}
                          value={alignments[active]?.[row.sourceKey] || ""}
                          onChange={(selected) =>
                            setAlignments((current) => ({
                              ...current,
                              [active]: {
                                ...current[active],
                                [row.sourceKey]: selected,
                              },
                            }))
                          }
                        >
                          {row.candidates.map((candidate) => (
                            <SingleSelectOption
                              key={candidate.key}
                              value={candidate.key}
                            >
                              {candidate.label} · {candidate.path}
                            </SingleSelectOption>
                          ))}
                        </SingleSelect>
                      </Box>
                    ))}
                  </>
                )}
              </>
            )}
          </Flex>
        </Modal.Body>
        <Modal.Footer style={{ flexWrap: "wrap", gap: 12 }}>
          <Button variant="tertiary" onClick={close} disabled={busy}>
            {phase === "pick"
              ? t("later", "Later")
              : phase === "running"
                ? t("cancel", "Cancel")
                : t("close", "Close")}
          </Button>
          {phase === "pick" && (
            <Button
              onClick={start}
              loading={busy}
              disabled={!targets.length || (!modules.length && !initial)}
            >
              {t("generate", "Preview translations")}
            </Button>
          )}
          {phase === "review" && (
            <Flex gap={2} wrap="wrap">
              <Button
                variant="secondary"
                onClick={() => {
                  setPhase("pick");
                  setError(null);
                  onRefresh?.();
                }}
                disabled={busy}
              >
                {t("change", "Change selection")}
              </Button>
              <Button
                onClick={accept}
                loading={busy}
                disabled={!preview || blocked || !!applied[active]}
              >
                {t("apply", "Apply {locale} changes", { locale: active || "" })}
              </Button>
            </Flex>
          )}
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
