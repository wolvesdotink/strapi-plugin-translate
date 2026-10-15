// Save-triggered dialog for translating only the modules that changed.
// Four phases:
//   pick    — choose changed modules, target languages and options
//   match   — confirm which translated module belongs to each source module
//             when a language can't tell same-type modules apart
//   running — per-language progress while previews are generated
//   review  — one tab per language: approve individual changes, then apply

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { useHref } from "react-router-dom";
import { useFetchClient } from "@strapi/strapi/admin";
import {
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  Flex,
  LinkButton,
  Modal,
  SingleSelect,
  SingleSelectOption,
  Tabs,
  TextButton,
  Typography,
} from "@strapi/design-system";
import {
  ArrowRight,
  CheckCircle,
  Clock,
  Cross,
  CrossCircle,
  Information,
  Link as LinkIcon,
  Loader,
  WarningCircle,
} from "@strapi/icons";
import pluginId from "../pluginId";
import {
  formatCost,
  formatTokens,
  humanizePath,
  humanizeSegment,
  moduleLabel,
  renderDiffValue,
} from "../utils/format";

const message = (error) =>
  error?.response?.data?.error?.message ||
  error.message ||
  "Translation failed";

const FINISHED = ["done", "partial", "failed", "cancelled"];
// Pick for a removed module the translation doesn't have (any more).
const NONE = "__none__";

const STATE_ICON = {
  pending: { Icon: Clock, color: "neutral500" },
  running: { Icon: Loader, color: "primary600" },
  done: { Icon: CheckCircle, color: "success600" },
  failed: { Icon: CrossCircle, color: "danger600" },
  cancelled: { Icon: Cross, color: "neutral500" },
};

const RELATION_BADGE = {
  available: { backgroundColor: "success100", textColor: "success700" },
  "draft-only": { backgroundColor: "neutral150", textColor: "neutral700" },
  missing: { backgroundColor: "warning100", textColor: "warning700" },
  created: { backgroundColor: "primary100", textColor: "primary700" },
};

// Toggle id for a preview field. Fields added with a new module share the
// structural operation that inserts it.
const opId = (field) => field.operationId || field.id;
const isEmpty = (value) =>
  value == null || value === "" || (Array.isArray(value) && value.length === 0);
// A new language lists every field; leave out empty ones that stay empty.
const shownFields = (row, fields) =>
  row.initialTranslation
    ? fields.filter(
        (field) =>
          !isEmpty(field.source) ||
          !isEmpty(field.before) ||
          !isEmpty(field.after),
      )
    : fields;
const isExcluded = (excluded, row, field) =>
  !!excluded[row.previewId]?.[opId(field)];

// Relation previews arrive as arrays of "Title (locale)" labels; everything
// else is a plain value. Lists render as rows instead of raw JSON.
const DiffValue = ({ value, textColor = "neutral800" }) => {
  if (
    Array.isArray(value) &&
    value.length &&
    value.every((v) => typeof v === "string")
  )
    return (
      <Flex direction="column" alignItems="flex-start" gap={1}>
        {value.map((item, i) => (
          <Typography key={i} variant="pi" textColor={textColor}>
            {item}
          </Typography>
        ))}
      </Flex>
    );
  const { text, muted } = renderDiffValue(
    Array.isArray(value) && !value.length ? null : value,
  );
  return (
    <Typography
      variant="pi"
      textColor={muted ? "neutral500" : textColor}
      tag="div"
      style={{
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        fontStyle: muted ? "italic" : "normal",
      }}
    >
      {text}
    </Typography>
  );
};

const SectionLabel = ({ children, aside }) => (
  <Flex justifyContent="space-between" alignItems="baseline" gap={3}>
    <Typography variant="sigma" textColor="neutral600">
      {children}
    </Typography>
    {aside}
  </Flex>
);

// Checkbox with a secondary line aligned under the label text.
const Option = ({ checked, onCheckedChange, disabled, label, hint }) => (
  <Flex direction="column" alignItems="stretch" gap={1}>
    <Checkbox
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
    >
      {label}
    </Checkbox>
    {hint && (
      <Box paddingLeft={6}>
        <Typography variant="pi" textColor="neutral600">
          {hint}
        </Typography>
      </Box>
    )}
  </Flex>
);

const Card = ({ children, ...props }) => (
  <Box
    background="neutral0"
    hasRadius
    borderColor="neutral200"
    borderWidth="1px"
    borderStyle="solid"
    {...props}
  >
    {children}
  </Box>
);

const NOTICE = {
  info: { Icon: Information, tone: "primary" },
  warning: { Icon: WarningCircle, tone: "warning" },
  danger: { Icon: CrossCircle, tone: "danger" },
};

// Inline, non-dismissable counterpart to the design-system Alert.
const Notice = ({ variant = "warning", title, children }) => {
  const { Icon, tone } = NOTICE[variant];
  return (
    <Box
      padding={4}
      background={`${tone}100`}
      hasRadius
      borderColor={`${tone}200`}
      borderWidth="1px"
      borderStyle="solid"
    >
      <Flex gap={3} alignItems="flex-start">
        <Box color={`${tone}700`} paddingTop={1} aria-hidden>
          <Icon width="1.6rem" height="1.6rem" />
        </Box>
        <Flex direction="column" alignItems="stretch" gap={2}>
          {title && (
            <Typography
              variant="omega"
              fontWeight="bold"
              textColor={`${tone}700`}
            >
              {title}
            </Typography>
          )}
          {children}
        </Flex>
      </Flex>
    </Box>
  );
};

// Top-level fields each arrive as their own module; show them as one card.
const groupModules = (modules = []) => {
  const groups = [];
  for (const module of modules) {
    const root = !module.sourcePath && groups.find((g) => g.root);
    if (root) {
      root.fields.push(...module.fields);
      root.keys.push(module.key);
    } else
      groups.push({
        ...module,
        root: !module.sourcePath,
        fields: [...module.fields],
        keys: [module.key],
      });
  }
  return groups;
};

// Uploads are served by the backend, which can differ from the admin host.
const fileUrl = (url) =>
  url?.startsWith("/") ? `${window.strapi?.backendURL || ""}${url}` : url;
const fieldName = (path) =>
  path
    .filter((part) => !/^\d+$/.test(part))
    .slice(-1)
    .map(humanizeSegment)[0];

// The first readable line of a module, for compact option labels.
const excerpt = (content, max = 70) => {
  const text =
    content?.texts?.[0]?.text ||
    content?.links?.[0] ||
    content?.media?.find((m) => m.name)?.name ||
    "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

// What a module says: its texts, images and linked items.
const ModuleContent = ({ content, emptyLabel, moreLabel, linksLabel }) => {
  const texts = content?.texts || [];
  const media = content?.media || [];
  const links = content?.links || [];
  if (!texts.length && !media.length && !links.length)
    return (
      <Typography
        variant="pi"
        textColor="neutral500"
        style={{ fontStyle: "italic" }}
      >
        {emptyLabel}
      </Typography>
    );
  const shown = texts.slice(0, 4);
  return (
    <Flex direction="column" alignItems="stretch" gap={2}>
      {shown.map((field, i) => (
        <Box key={i}>
          <Typography variant="sigma" textColor="neutral500" tag="p">
            {fieldName(field.name)}
          </Typography>
          <Typography
            variant="omega"
            textColor="neutral800"
            tag="p"
            style={{
              wordBreak: "break-word",
              display: "-webkit-box",
              WebkitLineClamp: 3,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {field.text}
          </Typography>
        </Box>
      ))}
      {texts.length > shown.length && (
        <Typography variant="pi" textColor="neutral500">
          {moreLabel(texts.length - shown.length)}
        </Typography>
      )}
      {media.length > 0 && (
        <Flex gap={2} wrap="wrap">
          {media.slice(0, 4).map((file, i) =>
            file.url ? (
              <img
                key={i}
                src={fileUrl(file.url)}
                alt={file.name || ""}
                title={file.name || ""}
                style={{
                  width: 64,
                  height: 48,
                  objectFit: "cover",
                  borderRadius: 4,
                  border: "1px solid var(--neutral200, #dcdce4)",
                }}
              />
            ) : (
              <Badge key={i} size="S">
                {file.name}
              </Badge>
            ),
          )}
        </Flex>
      )}
      {links.length > 0 && (
        <Flex gap={2} alignItems="flex-start">
          <Box color="neutral500" paddingTop={1} aria-hidden>
            <LinkIcon width="1.2rem" height="1.2rem" />
          </Box>
          <Typography variant="pi" textColor="neutral700">
            {linksLabel(links)}
          </Typography>
        </Flex>
      )}
    </Flex>
  );
};

export function ChangesModal({
  open,
  onClose,
  model,
  collectionType,
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
  const [allLocales, setAllLocales] = useState([]);
  const [localeStatus, setLocaleStatus] = useState(null);
  const [targets, setTargets] = useState([]);
  const [modules, setModules] = useState([]);
  const [linked, setLinked] = useState(false);
  const [initial, setInitial] = useState(false);
  const [phase, setPhase] = useState("pick");
  const [job, setJob] = useState(null);
  const [jobId, setJobId] = useState(null);
  const [active, setActive] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [excluded, setExcluded] = useState({});
  const [omit, setOmit] = useState({});
  const [alignments, setAlignments] = useState({});
  const [matchRows, setMatchRows] = useState({});
  const [matchLocale, setMatchLocale] = useState(null);
  const [applied, setApplied] = useState({});
  const [estimate, setEstimate] = useState(null);
  const [estimateError, setEstimateError] = useState(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const locales = allLocales.filter(
    (l) =>
      l.code !== sourceLocale &&
      (!changes.targetLocales || changes.targetLocales.includes(l.code)),
  );
  const localeName = (code) =>
    allLocales.find((l) => l.code === code)?.name || code;
  // The applied version opens in a new tab so the remaining languages stay
  // in this dialog.
  const versionHref = useHref(
    collectionType === "single-types"
      ? `/content-manager/single-types/${model}?plugins[i18n][locale]=${active}`
      : `/content-manager/collection-types/${model}/${documentId}?plugins[i18n][locale]=${active}`,
  );

  useEffect(() => {
    if (!open) return;
    let current = true;
    setPhase("pick");
    setError(null);
    setJob(null);
    setJobId(null);
    setApplied({});
    setAlignments({});
    setMatchRows({});
    setModules((changes?.modules || []).map((m) => m.key));
    get("/translate/locales")
      .then(({ data }) => {
        if (!current) return;
        const options = data.filter(
          (l) =>
            l.code !== sourceLocale &&
            (!changes.targetLocales || changes.targetLocales.includes(l.code)),
        );
        setAllLocales(data);
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
    // Which languages already have this document decides whether the
    // initial full translation option is relevant at all.
    post("/translate/content/locale-status", { uid: model, documentId })
      .then(({ data }) => {
        if (current)
          setLocaleStatus(
            Object.fromEntries((data?.locales || []).map((l) => [l.locale, l])),
          );
      })
      .catch(() => current && setLocaleStatus(null));
    return () => {
      current = false;
    };
  }, [open, sourceLocale, model, documentId]);

  useEffect(() => {
    if (!jobId || phase !== "running") return;
    let cancelled = false,
      timer;
    const poll = async () => {
      try {
        const { data } = await get(`/translate/jobs/${jobId}`);
        if (cancelled) return;
        setJob(data);
        if (FINISHED.includes(data.state)) {
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

  // A language that already has every selected change has nothing to
  // preview; it stays visible but can't be picked.
  const languageStatus = Object.fromEntries(
    (changes?.languages || []).map((l) => [l.locale, l]),
  );
  const pendingIn = (code) =>
    languageStatus[code]?.modules.filter((key) => modules.includes(key))
      .length ?? null;
  // `changes.languages` refreshes after each apply; the locale-status
  // response is only loaded when the dialog opens.
  const exists = (code) =>
    languageStatus[code]
      ? languageStatus[code].exists
      : (localeStatus?.[code]?.exists ?? true);
  const actionable = (code) => !exists(code) || pendingIn(code) > 0;
  const sendTargets = targets.filter(actionable);
  const sendKey = sendTargets.join(",");
  const onlySource =
    !!changes?.languages?.length && changes.languages.every((l) => !l.exists);

  const missingTargets = sendTargets.filter((code) => !exists(code));
  // These languages can only be previewed as a full initial translation.
  const needsInitial = initial ? [] : missingTargets;
  // Without status information the option stays visible so the editor can
  // still recover from a "no page exists" error.
  const showInitial =
    (!localeStatus && !changes?.languages) ||
    missingTargets.length > 0 ||
    initial;

  useEffect(() => {
    if (
      phase !== "pick" ||
      !sendTargets.length ||
      !modules.length ||
      needsInitial.length
    ) {
      setEstimate(null);
      setEstimateError(null);
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
          targetLocales: sendTargets,
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
    sendKey,
    modules,
    initial,
    linked,
    model,
    documentId,
    sourceLocale,
    changes.revision,
    post,
    alignments,
    needsInitial.length,
  ]);

  useEffect(() => {
    if (!open || phase !== "pick") return;
    const current = (changes.modules || []).map((module) => module.key);
    setModules((previous) => {
      const kept = previous.filter((key) => current.includes(key));
      return kept.length ? kept : current;
    });
  }, [changes.revision]);

  const start = async (chosen, targetLocales = sendTargets) => {
    if (!targetLocales.length || (!modules.length && !initial)) return;
    setBusy(true);
    setError(null);
    setExcluded({});
    setOmit({});
    setApplied({});
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
        targetLocales,
        revision: changes.revision,
        moduleKeys: modules,
        translateLinkedItems: linked,
        initialTranslation: initial,
        alignments: chosen,
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
  // Pre-select the suggested pair for every module that still needs one.
  // Earlier picks stay only while they are still among the candidates.
  const withSuggestions = (current, found) => {
    const next = { ...current };
    for (const [locale, rows] of found) {
      const picks = { ...next[locale] };
      for (const row of rows)
        if (
          !(row.removed && picks[row.sourceKey] === NONE) &&
          !row.candidates.some((c) => c.key === picks[row.sourceKey])
        ) {
          if (row.suggested) picks[row.sourceKey] = row.suggested;
          else delete picks[row.sourceKey];
        }
      next[locale] = picks;
    }
    return next;
  };
  const openMatch = (found, chosen, merge) => {
    setAlignments(chosen);
    setMatchRows((current) => {
      const next = merge ? { ...current } : {};
      for (const [locale, rows] of found) {
        const fresh = new Map(rows.map((row) => [row.sourceKey, row]));
        const known = new Set((next[locale] || []).map((r) => r.sourceKey));
        next[locale] = [
          ...(next[locale] || []).map((row) => fresh.get(row.sourceKey) || row),
          ...rows.filter((row) => !known.has(row.sourceKey)),
        ];
      }
      return next;
    });
    setMatchLocale((current) =>
      merge && found.some(([locale]) => locale === current)
        ? current
        : found[0][0],
    );
    setPhase("match");
  };
  // Picks for the rows on screen; stale picks from earlier rounds could
  // override pairs the plugin already knows.
  const shownPicks = () =>
    Object.fromEntries(
      Object.entries(matchRows).map(([locale, rows]) => [
        locale,
        Object.fromEntries(
          rows
            .filter((row) => alignments[locale]?.[row.sourceKey])
            .map((row) => [
              row.sourceKey,
              alignments[locale][row.sourceKey] === NONE
                ? null
                : alignments[locale][row.sourceKey],
            ]),
        ),
      ]),
    );
  // Same-type modules a language can't pair on its own are matched before
  // anything is generated. The check runs again after confirming: modules
  // nested in a list only become comparable once their parent is matched.
  const proceed = async (only) => {
    const targetLocales = only || sendTargets;
    if (!targetLocales.length || (!modules.length && !initial)) return;
    // Only pairs confirmed in the matching step are sent; earlier picks
    // come back as pre-selections instead of being applied silently.
    const confirmed = phase === "match" ? shownPicks() : {};
    setBusy(true);
    setError(null);
    try {
      const existing = targetLocales.filter(exists);
      const { data } = existing.length
        ? await post("/translate/changes/alignment", {
            uid: model,
            documentId,
            sourceLocale,
            targetLocales: existing,
            revision: changes.revision,
            moduleKeys: modules,
            alignments: confirmed,
          })
        : { data: { locales: {} } };
      if (!mounted.current) return;
      const found = Object.entries(data?.locales || {}).filter(
        ([, rows]) => rows.length,
      );
      if (found.length)
        openMatch(found, withSuggestions(alignments, found), phase === "match");
      else await start(confirmed, targetLocales);
    } catch (err) {
      if (mounted.current) setError(message(err));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  // A different parent module has different nested modules: drop the
  // nested picks and rows; confirming fetches the new ones.
  const choose = (locale, sourceKey, targetKey) => {
    const nested = (key) => key.startsWith(`${sourceKey}/`);
    setAlignments((current) => ({
      ...current,
      [locale]: {
        ...Object.fromEntries(
          Object.entries(current[locale] || {}).filter(([key]) => !nested(key)),
        ),
        [sourceKey]: targetKey,
      },
    }));
    setMatchRows((current) => ({
      ...current,
      [locale]: (current[locale] || []).filter((row) => !nested(row.sourceKey)),
    }));
  };
  // Rows without a pick, or sharing a pick with another row.
  const matchProblems = (locale) => {
    const chosen = alignments[locale] || {};
    const rows = matchRows[locale] || [];
    const uses = {};
    for (const row of rows)
      if (chosen[row.sourceKey] && chosen[row.sourceKey] !== NONE)
        uses[chosen[row.sourceKey]] = (uses[chosen[row.sourceKey]] || 0) + 1;
    return new Set(
      rows
        .filter(
          (row) => !chosen[row.sourceKey] || uses[chosen[row.sourceKey]] > 1,
        )
        .map((row) => row.sourceKey),
    );
  };
  const matchReady = Object.keys(matchRows).every(
    (locale) => matchProblems(locale).size === 0,
  );
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
  // A linked-item preview only counts once at least one of its changes is
  // approved; unapproved children neither resolve nor block parent links.
  const isSelected = (row) =>
    row.initialTranslation ||
    row.modules.some((module) =>
      module.fields.some((field) => !isExcluded(excluded, row, field)),
    );
  const missingRelations = (row) =>
    (row?.relations || []).filter((relation) => {
      const field = row.modules
        .flatMap((module) => module.fields)
        .find((field) => field.id === relation.fieldKey);
      return (
        !excluded[row.previewId]?.[field ? opId(field) : relation.fieldKey] &&
        relation.status === "missing" &&
        !row.children?.some(
          (child) =>
            isSelected(child) &&
            child.uid === relation.uid &&
            child.documentId === relation.documentId,
        )
      );
    });
  // Each row approves omitting its own optional links separately.
  const blocked = [preview, ...(preview?.children || []).filter(isSelected)]
    .filter(Boolean)
    .some((row) => {
      const missing = missingRelations(row);
      return (
        missing.some((relation) => relation.required) ||
        (missing.length > 0 && !omit[row.previewId])
      );
    });

  // Approval counts across the preview and its linked-item previews. Each
  // toggle is one operation, however many fields it renders.
  const counts = useMemo(() => {
    let total = 0,
      selected = 0;
    for (const row of preview ? [preview, ...(preview.children || [])] : []) {
      const ops = new Map();
      for (const module of row.modules || [])
        for (const field of module.fields)
          ops.set(opId(field), isExcluded(excluded, row, field));
      total += ops.size;
      selected += [...ops.values()].filter((off) => !off).length;
    }
    return { total, selected };
  }, [preview, excluded]);

  const nextLocale = job?.targets?.find(
    (item) =>
      item.locale !== active && item.state === "done" && !applied[item.locale],
  )?.locale;
  const allApplied =
    !!job?.targets?.length &&
    job.targets.every(
      (item) => applied[item.locale] || item.state !== "done",
    ) &&
    Object.keys(applied).length > 0;

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
          childAllowMissingRelations: Object.fromEntries(
            (preview.children || []).map((child) => [
              child.previewId,
              !!omit[child.previewId],
            ]),
          ),
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
  // Previews are stored server-side until applied; drop the ones left over.
  const discardPending = async () => {
    for (const item of job?.targets || []) {
      if (item.result?.previewId && !applied[item.locale])
        await post(`/translate/preview/${item.result.previewId}/discard`).catch(
          () => {},
        );
    }
  };
  const close = async () => {
    if (busy) return;
    if (phase === "running" && jobId)
      await post(`/translate/jobs/${jobId}/cancel`).catch(() => {});
    await discardPending();
    onClose();
  };
  const backToPick = async () => {
    setBusy(true);
    await discardPending();
    if (!mounted.current) return;
    setBusy(false);
    setPhase("pick");
    setJob(null);
    setJobId(null);
    setApplied({});
    setError(null);
    onRefresh?.();
  };

  // A preview can still stop on ambiguous modules (e.g. the translation
  // changed meanwhile); those go through the same matching step.
  const rematch = async () => {
    const locales = (job?.targets || [])
      .filter((item) => item.result?.details?.alignments?.length)
      .map((item) => item.locale);
    await backToPick();
    // Fresh rows carry content filtered for this editor.
    if (mounted.current && locales.length) await proceed(locales);
  };

  const allModulesSelected = modules.length === (changes?.modules || []).length;

  const renderPick = () => (
    <>
      <Typography variant="omega" textColor="neutral600">
        {onlySource
          ? t(
              "introNew",
              "This entry only exists in {language} so far. Pick the languages to create it in. You review every translation before anything is saved.",
              { language: localeName(sourceLocale) },
            )
          : !(changes?.modules || []).length
            ? t(
                "introMissing",
                "Every existing language is up to date. Pick the missing languages to create this entry in. You review every translation before anything is saved.",
              )
            : t(
                "intro",
                "Pick the modules to send for translation. Everything else in the translated versions stays as it is.",
              )}
      </Typography>

      {(changes?.modules || []).length > 0 && (
        <Flex direction="column" alignItems="stretch" gap={2}>
          <SectionLabel
            aside={
              (changes?.modules || []).length > 1 && (
                <TextButton
                  onClick={() =>
                    setModules(
                      allModulesSelected
                        ? []
                        : (changes.modules || []).map((m) => m.key),
                    )
                  }
                >
                  {allModulesSelected
                    ? t("selectNone", "Clear selection")
                    : t("selectAll", "Select all")}
                </TextButton>
              )
            }
          >
            {t("modules", "Changed modules")}
          </SectionLabel>
          <Card>
            {(changes?.modules || []).map((module, i) => (
              <Box
                key={module.key}
                paddingTop={3}
                paddingBottom={3}
                paddingLeft={4}
                paddingRight={4}
                borderColor="neutral200"
                style={
                  i > 0
                    ? { borderTopWidth: 1, borderTopStyle: "solid" }
                    : undefined
                }
              >
                <Option
                  checked={modules.includes(module.key)}
                  onCheckedChange={(checked) =>
                    toggle(setModules, module.key, checked)
                  }
                  label={
                    <Typography variant="omega" fontWeight="semiBold">
                      {moduleLabel(module)}
                    </Typography>
                  }
                  hint={[
                    humanizePath(module.path),
                    module.fields
                      .map((field) =>
                        field.kind === "structure"
                          ? t("structureChange", "{name} order", {
                              name: humanizeSegment(field.name),
                            })
                          : humanizeSegment(field.name),
                      )
                      .join(", "),
                  ]
                    // A top-level field would repeat its own name.
                    .filter((part) => part && part !== moduleLabel(module))
                    .filter((part, i, parts) => parts.indexOf(part) === i)
                    .join(" · ")}
                />
              </Box>
            ))}
          </Card>
        </Flex>
      )}

      <Flex direction="column" alignItems="stretch" gap={2}>
        <SectionLabel>{t("languages", "Translate into")}</SectionLabel>
        <Flex wrap="wrap" gap={2}>
          {locales.map((locale) => {
            const enabled = actionable(locale.code);
            const checked = enabled && targets.includes(locale.code);
            const missing = !exists(locale.code);
            const pending = missing ? null : pendingIn(locale.code);
            return (
              <Box
                key={locale.code}
                paddingTop={2}
                paddingBottom={2}
                paddingLeft={3}
                paddingRight={3}
                hasRadius
                background={checked ? "primary100" : "neutral0"}
                borderColor={checked ? "primary200" : "neutral200"}
                borderWidth="1px"
                borderStyle="solid"
              >
                <Checkbox
                  checked={checked}
                  disabled={!enabled}
                  onCheckedChange={(value) =>
                    toggle(setTargets, locale.code, value)
                  }
                >
                  <Flex gap={2} alignItems="center" tag="span">
                    {locale.name || locale.code}
                    {missing ? (
                      <Badge
                        size="S"
                        backgroundColor="warning100"
                        textColor="warning700"
                      >
                        {t("noVersion", "Not created yet")}
                      </Badge>
                    ) : pending === 0 ? (
                      <Badge size="S">
                        {languageStatus[locale.code].modules.length
                          ? t("notSelected", "No selected changes")
                          : t("upToDate", "Up to date")}
                      </Badge>
                    ) : pending ? (
                      <Badge size="S">
                        {t(
                          "pendingCount",
                          "{count, plural, one {# change} other {# changes}}",
                          { count: pending },
                        )}
                      </Badge>
                    ) : null}
                  </Flex>
                </Checkbox>
              </Box>
            );
          })}
        </Flex>
        {!locales.length && !error && (
          <Typography variant="pi" textColor="neutral600">
            {t("noLanguages", "No other languages are configured.")}
          </Typography>
        )}
      </Flex>

      <Flex direction="column" alignItems="stretch" gap={3}>
        <SectionLabel>{t("options", "Options")}</SectionLabel>
        <Option
          checked={linked}
          onCheckedChange={setLinked}
          label={t("linked", "Also translate linked items")}
          hint={t(
            "linkedHelp",
            "Links to items that already exist in the target language are kept automatically. Turn this on to also translate pending changes in linked items and create missing ones.",
          )}
        />
        {showInitial && (
          <Option
            checked={initial}
            onCheckedChange={setInitial}
            label={t("initial", "Create missing languages")}
            hint={
              missingTargets.length
                ? t(
                    "initialHelpMissing",
                    "{languages} {count, plural, one {doesn't} other {don't}} have this entry yet. Turn this on to create {count, plural, one {it} other {them}} with a translation of the whole entry, including anything not selected above. You review it before anything is saved.",
                    {
                      languages: missingTargets.map(localeName).join(", "),
                      count: missingTargets.length,
                    },
                  )
                : t(
                    "initialHelp",
                    "Languages without this entry get a full translation instead of only the changed modules.",
                  )
            }
          />
        )}
      </Flex>

      {(needsInitial.length > 0 || estimate || estimateError) && (
        <Box
          paddingTop={3}
          paddingBottom={3}
          paddingLeft={4}
          paddingRight={4}
          background="neutral100"
          hasRadius
        >
          {needsInitial.length ? (
            <Typography variant="pi" textColor="warning700">
              {t(
                "needsInitial",
                "Turn on “Create missing languages” to translate into {languages}.",
                { languages: needsInitial.map(localeName).join(", ") },
              )}
            </Typography>
          ) : estimate ? (
            <Typography variant="pi" textColor="neutral700">
              {t(
                "estimate",
                "Estimated usage: {input} input + {output} output tokens",
                {
                  input: formatTokens(estimate.inputTokens),
                  output: formatTokens(estimate.estimatedOutputTokens),
                },
              )}
              {formatCost(estimate.estimatedCostUsd) &&
                ` · ≈${formatCost(estimate.estimatedCostUsd)}`}
            </Typography>
          ) : (
            <Typography variant="pi" textColor="warning700">
              {estimateError}
            </Typography>
          )}
        </Box>
      )}
    </>
  );

  const renderRunning = () => (
    <>
      <Flex gap={3} alignItems="flex-start">
        <Box color="primary600" paddingTop={1} aria-hidden>
          <Loader />
        </Box>
        <Box>
          <Typography variant="omega" fontWeight="semiBold" tag="p">
            {t("generating", "Preparing previews…")}
          </Typography>
          <Typography variant="pi" textColor="neutral600">
            {t(
              "generatingHelp",
              "Nothing is saved until you review and apply the changes.",
            )}
          </Typography>
        </Box>
      </Flex>
      <Flex direction="column" alignItems="stretch" gap={1}>
        {(
          job?.targets ||
          sendTargets.map((locale) => ({ locale, state: "pending" }))
        ).map((item) => {
          const { Icon, color } = STATE_ICON[item.state] || STATE_ICON.pending;
          return (
            <Card
              key={item.locale}
              paddingTop={2}
              paddingBottom={2}
              paddingLeft={3}
              paddingRight={3}
            >
              <Flex gap={2} alignItems="center">
                <Box color={color} aria-hidden>
                  <Icon width="1.6rem" height="1.6rem" />
                </Box>
                <Typography variant="omega" fontWeight="semiBold">
                  {localeName(item.locale)}
                </Typography>
              </Flex>
            </Card>
          );
        })}
      </Flex>
    </>
  );

  const renderField = (row, field, locked) => {
    const off = isExcluded(excluded, row, field);
    const inserted = field.kind === "inserted-field";
    // Links in a changed module are re-resolved even when they don't change;
    // show those once instead of as two identical columns.
    const unchanged =
      !inserted && JSON.stringify(field.before) === JSON.stringify(field.after);
    const toggleable = !locked && !row.initialTranslation && !inserted;
    return (
      <Box
        key={field.id}
        borderColor="neutral200"
        style={{ borderTopWidth: 1, borderTopStyle: "solid" }}
      >
        <Flex
          paddingTop={2}
          paddingBottom={2}
          paddingLeft={4}
          paddingRight={4}
          justifyContent="space-between"
          alignItems="center"
          gap={3}
        >
          <Flex gap={2} alignItems="center" wrap="wrap">
            <Typography
              variant="pi"
              fontWeight="bold"
              textColor={off ? "neutral500" : "neutral800"}
            >
              {humanizeSegment(field.name)}
            </Typography>
            {field.kind === "structure" && (
              <Badge size="S">{t("structure", "Order and items")}</Badge>
            )}
            {inserted && (
              <Badge
                size="S"
                backgroundColor="primary100"
                textColor="primary700"
              >
                {t("inserted", "New module")}
              </Badge>
            )}
          </Flex>
          {toggleable && (
            <Box shrink={0}>
              <Checkbox
                checked={!off}
                disabled={busy}
                onCheckedChange={(checked) =>
                  toggleField(opId(field), checked, row.previewId)
                }
              >
                <Typography variant="pi" textColor="neutral600">
                  {t("applyField", "Apply")}
                </Typography>
              </Checkbox>
            </Box>
          )}
        </Flex>
        <Box
          paddingBottom={3}
          paddingLeft={4}
          paddingRight={4}
          style={{ opacity: off ? 0.45 : 1 }}
        >
          <Flex direction="column" alignItems="stretch" gap={2}>
            <Box>
              <Typography variant="pi" textColor="neutral500">
                {t("source", "{language} source", {
                  language: localeName(row.sourceLocale || sourceLocale),
                })}
              </Typography>
              <DiffValue value={field.source} textColor="neutral600" />
            </Box>
            <div
              style={{
                display: "grid",
                gridTemplateColumns:
                  "repeat(auto-fit, minmax(min(100%, 240px), 1fr))",
                gap: 8,
              }}
            >
              {unchanged ? (
                <Box
                  padding={2}
                  paddingLeft={3}
                  hasRadius
                  background="neutral100"
                >
                  <Typography
                    variant="pi"
                    textColor="neutral600"
                    fontWeight="bold"
                  >
                    {t("unchanged", "No change")}
                  </Typography>
                  <DiffValue value={field.after} />
                </Box>
              ) : (
                <>
                  {!inserted && !row.initialTranslation && (
                    <Box
                      padding={2}
                      paddingLeft={3}
                      hasRadius
                      background="neutral100"
                      style={{
                        borderLeft: "3px solid var(--danger600, #d02b20)",
                      }}
                    >
                      <Typography
                        variant="pi"
                        textColor="danger700"
                        fontWeight="bold"
                      >
                        {t("current", "Current")}
                      </Typography>
                      <DiffValue value={field.before} />
                    </Box>
                  )}
                  <Box
                    padding={2}
                    paddingLeft={3}
                    hasRadius
                    background="success100"
                    style={{
                      borderLeft: "3px solid var(--success600, #328048)",
                    }}
                  >
                    <Typography
                      variant="pi"
                      textColor="success700"
                      fontWeight="bold"
                    >
                      {t("proposed", "Translated")}
                    </Typography>
                    <DiffValue value={field.after} />
                  </Box>
                </>
              )}
            </div>
            {off && (
              <Typography
                variant="pi"
                textColor="neutral600"
                style={{ fontStyle: "italic" }}
              >
                {inserted
                  ? t("insertedSkipped", "Skipped together with its module.")
                  : t("keepingCurrent", "Keeps its current value.")}
              </Typography>
            )}
          </Flex>
        </Box>
      </Box>
    );
  };

  const renderRelation = (row, relation, index) => {
    // A missing item counts as covered once its linked-item preview is approved.
    const status =
      relation.status === "missing" &&
      row.children?.some(
        (child) =>
          isSelected(child) &&
          child.uid === relation.uid &&
          child.documentId === relation.documentId,
      )
        ? "created"
        : relation.status;
    const label =
      status === "created"
        ? t("childCreated", "Will be created")
        : status === "missing"
          ? t("missing", "Not translated yet")
          : status === "draft-only"
            ? t("draftOnly", "Draft")
            : t("available", "Published");
    return (
      <Flex
        key={`${relation.path}:${index}`}
        gap={2}
        alignItems="center"
        justifyContent="space-between"
        wrap="wrap"
      >
        <Flex gap={2} alignItems="center">
          <Box color="neutral500" aria-hidden>
            <LinkIcon width="1.2rem" height="1.2rem" />
          </Box>
          <Typography variant="pi" textColor="neutral800">
            {relation.label}
          </Typography>
        </Flex>
        <Flex gap={1}>
          {relation.required && status === "missing" && (
            <Badge size="S" backgroundColor="danger100" textColor="danger700">
              {t("required", "Required")}
            </Badge>
          )}
          <Badge size="S" {...RELATION_BADGE[status]}>
            {label}
          </Badge>
        </Flex>
      </Flex>
    );
  };

  const renderRow = (row, locked) => {
    const moduleKeys = new Set((row.modules || []).map((m) => m.key));
    const orphanRelations = (row.relations || []).filter(
      (r) => !moduleKeys.has(r.moduleKey),
    );
    return (
      <Flex direction="column" alignItems="stretch" gap={3}>
        {groupModules(row.modules).map((module) => {
          const relations = (row.relations || []).filter((r) =>
            module.keys.includes(r.moduleKey),
          );
          const fields = shownFields(row, module.fields);
          if (!fields.length && !relations.length) return null;
          return (
            <Card key={module.key} shadow="tableShadow">
              <Flex
                paddingTop={3}
                paddingBottom={3}
                paddingLeft={4}
                paddingRight={4}
                background="neutral100"
                justifyContent="space-between"
                alignItems="center"
                gap={3}
                wrap="wrap"
                style={{ borderRadius: "4px 4px 0 0" }}
              >
                <Box>
                  <Typography variant="omega" fontWeight="bold" tag="p">
                    {module.label}
                  </Typography>
                  {module.sourcePath && (
                    <Typography variant="pi" textColor="neutral600">
                      {humanizePath(module.sourcePath)}
                    </Typography>
                  )}
                </Box>
              </Flex>
              {fields.map((field) => renderField(row, field, locked))}
              {relations.length > 0 && (
                <Box
                  padding={4}
                  paddingTop={3}
                  borderColor="neutral200"
                  style={{ borderTopWidth: 1, borderTopStyle: "solid" }}
                >
                  <Flex direction="column" alignItems="stretch" gap={2}>
                    <Typography variant="pi" textColor="neutral500">
                      {t("linkedIn", "Linked items in {language}", {
                        language: localeName(row.targetLocale),
                      })}
                    </Typography>
                    {relations.map((relation, i) =>
                      renderRelation(row, relation, i),
                    )}
                  </Flex>
                </Box>
              )}
            </Card>
          );
        })}
        {orphanRelations.length > 0 && (
          <Card padding={4}>
            <Flex direction="column" alignItems="stretch" gap={2}>
              <Typography variant="pi" textColor="neutral500">
                {t("linkedIn", "Linked items in {language}", {
                  language: localeName(row.targetLocale),
                })}
              </Typography>
              {orphanRelations.map((relation, i) =>
                renderRelation(row, relation, i),
              )}
            </Flex>
          </Card>
        )}
      </Flex>
    );
  };

  const renderMissing = (row, child = false) => {
    const missing = isSelected(row) ? missingRelations(row) : [];
    if (!missing.length) return null;
    const required = missing.some((relation) => relation.required);
    return (
      <Notice
        title={
          child
            ? t(
                "childMissingLinks",
                "{label} links to {count, plural, one {# item that isn't} other {# items that aren't}} available in {language}",
                {
                  label: row.label,
                  count: missing.length,
                  language: localeName(active),
                },
              )
            : t(
                "missingLinks",
                "{count, plural, one {# linked item isn't} other {# linked items aren't}} available in {language}",
                { count: missing.length, language: localeName(active) },
              )
        }
      >
        <Typography variant="pi" textColor="warning700">
          {child
            ? required
              ? t(
                  "childMissingRequired",
                  "A required link can't be left empty. Translate the linked item first, then generate the preview again.",
                )
              : t(
                  "childMissingOptional",
                  "Apply without these links, or translate the linked item first and generate the preview again.",
                )
            : required
              ? t(
                  "missingRequired",
                  "A required link can't be left empty. Go back and turn on “Also translate linked items” to create the missing translation.",
                )
              : t(
                  "missingOptional",
                  "Go back and turn on “Also translate linked items” to create the missing translation, or apply without these links.",
                )}
        </Typography>
        {!required && (
          <Checkbox
            checked={!!omit[row.previewId]}
            disabled={busy || !!applied[active]}
            onCheckedChange={(checked) =>
              setOmit((current) => ({ ...current, [row.previewId]: checked }))
            }
          >
            {child
              ? t("omitChild", "Apply {label} without these links", {
                  label: row.label,
                })
              : t("omit", "Apply without these links")}
          </Checkbox>
        )}
      </Notice>
    );
  };

  const renderPreview = () => {
    const locked = busy;
    const repairs = (preview.warnings || []).filter((w) => w.message);
    return (
      <Flex direction="column" alignItems="stretch" gap={4}>
        <Typography variant="pi" textColor="neutral600">
          {preview.initialTranslation
            ? t(
                "initialIntro",
                "{language} doesn't have this entry yet. Applying creates it with the full translation below.",
                { language: localeName(active) },
              )
            : t(
                "reviewIntro",
                "{selected} of {total} changes selected. Uncheck a change to keep the current translation.",
                counts,
              )}
        </Typography>

        {renderMissing(preview)}

        {repairs.length > 0 && (
          <Notice title={t("repairs", "Adjusted to pass validation")}>
            {repairs.map((w, i) => (
              <Typography key={i} variant="pi" textColor="warning700">
                {w.message}
              </Typography>
            ))}
          </Notice>
        )}

        {renderRow(preview, locked)}

        {(preview.children || []).length > 0 && (
          <Flex direction="column" alignItems="stretch" gap={3}>
            <SectionLabel>{t("linkedItems", "Linked items")}</SectionLabel>
            {preview.children.map((child) => (
              <Flex
                key={child.previewId}
                direction="column"
                alignItems="stretch"
                gap={2}
              >
                <Flex gap={2} alignItems="center" wrap="wrap">
                  <Typography variant="omega" fontWeight="semiBold">
                    {child.label}
                  </Typography>
                  {child.initialTranslation && (
                    <Badge
                      size="S"
                      backgroundColor="primary100"
                      textColor="primary700"
                    >
                      {t("childCreated", "Will be created")}
                    </Badge>
                  )}
                </Flex>
                {renderMissing(child, true)}
                {renderRow(child, locked)}
              </Flex>
            ))}
          </Flex>
        )}

        <Typography variant="pi" textColor="neutral500">
          {t(
            "draftHelp",
            "Changes are saved to the draft. Publishing stays a separate step; content types without drafts are updated live.",
          )}
        </Typography>
      </Flex>
    );
  };

  const renderApplied = () => (
    <Box
      padding={6}
      background="success100"
      hasRadius
      borderColor="success200"
      borderWidth="1px"
      borderStyle="solid"
    >
      <Flex direction="column" alignItems="center" gap={2}>
        <Box color="success600" aria-hidden>
          <CheckCircle width="3.2rem" height="3.2rem" />
        </Box>
        <Typography variant="delta" textColor="success700" tag="p">
          {t("applied", "{language} updated", { language: localeName(active) })}
        </Typography>
        <Typography variant="pi" textColor="neutral700" textAlign="center">
          {t(
            "appliedHelp",
            "The approved changes are saved. If this content uses drafts, visitors see them only after you publish {language}.",
            { language: localeName(active) },
          )}
        </Typography>
        <Flex paddingTop={2} gap={2} wrap="wrap" justifyContent="center">
          <LinkButton
            variant="tertiary"
            href={versionHref}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("open", "Open {language}", { language: localeName(active) })}
          </LinkButton>
          {nextLocale && (
            <Button
              variant="secondary"
              endIcon={<ArrowRight />}
              onClick={() => {
                setActive(nextLocale);
                setError(null);
              }}
            >
              {t("next", "Review {language}", {
                language: localeName(nextLocale),
              })}
            </Button>
          )}
        </Flex>
      </Flex>
    </Box>
  );

  const renderFailed = () => {
    const needsMatch = !!target?.result?.details?.alignments?.length;
    return (
      <Notice
        variant={needsMatch ? "warning" : "danger"}
        title={
          needsMatch
            ? t("alignTitle", "Some modules need matching")
            : t("failed", "This preview couldn't be generated")
        }
      >
        <Typography
          variant="pi"
          textColor={needsMatch ? "warning700" : "danger700"}
        >
          {needsMatch
            ? t(
                "alignHelp",
                "The {language} version can't tell some of its modules apart. Confirm which module is which, then the previews are generated again.",
                { language: localeName(active) },
              )
            : target?.error || job?.error}
        </Typography>
        {needsMatch && (
          <Box>
            <Button variant="secondary" onClick={rematch} disabled={busy}>
              {t("matchAction", "Match modules")}
            </Button>
          </Box>
        )}
      </Notice>
    );
  };

  // "page.3" reads as "No. 4 in Page"; nested lists keep their parent path.
  const place = (path) => {
    const parts = String(path || "").split(".");
    const last = parts.at(-1);
    if (!/^\d+$/.test(last)) return humanizePath(path);
    return t("place", "No. {position} in {list}", {
      position: Number(last) + 1,
      list: humanizePath(parts.slice(0, -1).join(".")),
    });
  };
  const contentLabels = {
    emptyLabel: t("noContent", "No text or images"),
    moreLabel: (count) =>
      t(
        "moreFields",
        "+ {count, plural, one {# more field} other {# more fields}}",
        {
          count,
        },
      ),
    linksLabel: (links) =>
      links.length > 3
        ? t("linksMore", "{links} and {count} more", {
            links: links.slice(0, 3).join(", "),
            count: links.length - 3,
          })
        : links.join(", "),
  };

  const renderMatchRow = (locale, row, problems) => {
    const chosen = alignments[locale]?.[row.sourceKey] || null;
    const candidate = row.candidates.find((c) => c.key === chosen);
    // Which other source module already uses each candidate.
    const usedBy = {};
    for (const other of matchRows[locale] || [])
      if (other.sourceKey !== row.sourceKey) {
        const key = alignments[locale]?.[other.sourceKey];
        if (key && key !== NONE) usedBy[key] = other;
      }
    const clash = chosen && usedBy[chosen];
    const problem = problems.has(row.sourceKey);
    const language = localeName(locale);
    return (
      <Card key={row.sourceKey} shadow="tableShadow">
        <Flex
          paddingTop={3}
          paddingBottom={3}
          paddingLeft={4}
          paddingRight={4}
          background="neutral100"
          justifyContent="space-between"
          alignItems="center"
          gap={3}
          wrap="wrap"
          style={{ borderRadius: "4px 4px 0 0" }}
        >
          <Box>
            <Typography variant="omega" fontWeight="bold" tag="p">
              {row.label}
            </Typography>
            <Typography variant="pi" textColor="neutral600">
              {place(row.sourcePath)}
            </Typography>
          </Box>
          <Flex gap={1}>
            {row.changed && (
              <Badge
                size="S"
                backgroundColor="primary100"
                textColor="primary700"
              >
                {t("edited", "Edited")}
              </Badge>
            )}
            {row.removed && (
              <Badge
                size="S"
                backgroundColor="warning100"
                textColor="warning700"
              >
                {t("removedIn", "Removed in {language}", {
                  language: localeName(sourceLocale),
                })}
              </Badge>
            )}
          </Flex>
        </Flex>
        <Box padding={4}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns:
                "repeat(auto-fit, minmax(min(100%, 280px), 1fr))",
              gap: 12,
            }}
          >
            <Box padding={3} hasRadius background="neutral100">
              <Flex direction="column" alignItems="stretch" gap={3}>
                <SectionLabel>{localeName(sourceLocale)}</SectionLabel>
                <ModuleContent content={row.content} {...contentLabels} />
              </Flex>
            </Box>
            <Box
              padding={3}
              hasRadius
              background="neutral0"
              borderColor={problem ? "danger600" : "neutral200"}
              borderWidth="1px"
              borderStyle="solid"
            >
              <Flex direction="column" alignItems="stretch" gap={3}>
                <SectionLabel>{language}</SectionLabel>
                <Box>
                  <SingleSelect
                    aria-label={t(
                      "matchLabel",
                      "{language} module for {module}",
                      {
                        language,
                        module: `${row.label} ${place(row.sourcePath)}`,
                      },
                    )}
                    placeholder={t(
                      "matchPlaceholder",
                      "Choose the matching module",
                    )}
                    value={chosen || ""}
                    hasError={problem}
                    disabled={busy || (!row.candidates.length && !row.removed)}
                    onChange={(value) => choose(locale, row.sourceKey, value)}
                  >
                    {row.candidates.map((option) => (
                      <SingleSelectOption key={option.key} value={option.key}>
                        {[
                          t("optionPosition", "No. {position}", {
                            position: option.position,
                          }),
                          excerpt(option.content) || option.label,
                          usedBy[option.key] &&
                            t("usedFor", "used for No. {position}", {
                              position: usedBy[option.key].position,
                            }),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </SingleSelectOption>
                    ))}
                    {row.removed && (
                      <SingleSelectOption value={NONE}>
                        {t("matchNoneOption", "Not in the {language} version", {
                          language,
                        })}
                      </SingleSelectOption>
                    )}
                  </SingleSelect>
                  <Box paddingTop={1}>
                    <Typography
                      variant="pi"
                      textColor={problem ? "danger600" : "neutral600"}
                    >
                      {chosen === NONE
                        ? t(
                            "matchNoneChosen",
                            "Nothing is removed from the {language} version.",
                            { language },
                          )
                        : !row.candidates.length
                          ? t(
                              "matchNone",
                              "Every {language} module of this type is already matched to another one. Go back and leave this module out, or add it to the {language} version first.",
                              { language },
                            )
                          : !chosen
                            ? t(
                                "matchMissing",
                                "Pick the {language} module that translates this one.",
                                {
                                  language,
                                },
                              )
                            : clash
                              ? t(
                                  "matchClash",
                                  "Also picked for {module}. Each {language} module can only be matched once.",
                                  {
                                    module: `${clash.label} ${place(clash.sourcePath)}`,
                                    language,
                                  },
                                )
                              : row.removed
                                ? t(
                                    "matchRemoved",
                                    "This {language} module is removed when you apply the translation.",
                                    { language },
                                  )
                                : chosen === row.suggested
                                  ? t(
                                      "matchSuggested",
                                      "Suggested from position and content.",
                                    )
                                  : null}
                    </Typography>
                  </Box>
                </Box>
                {candidate && (
                  <ModuleContent
                    content={candidate.content}
                    {...contentLabels}
                  />
                )}
              </Flex>
            </Box>
          </div>
        </Box>
      </Card>
    );
  };

  const renderMatchLocale = (locale) => {
    const rows = matchRows[locale] || [];
    const problems = matchProblems(locale);
    const language = localeName(locale);
    return (
      <Flex direction="column" alignItems="stretch" gap={4}>
        <Notice
          variant="info"
          title={t("matchTitle", "Which {language} module is which?", {
            language,
          })}
        >
          <Typography variant="pi" textColor="neutral800">
            {t(
              "matchHelp",
              "This page has several modules of the same type, and the plugin can't tell yet which {language} module translates which {source} module. Check the pairs below so the changes land in the right place.",
              { language, source: localeName(sourceLocale) },
            )}
          </Typography>
          <Typography variant="pi" textColor="neutral800">
            {t(
              "matchHelpSuggested",
              "Each pair is pre-selected by position and content. Compare the texts and change any pair that doesn't fit. After you apply the translation, the plugin remembers these pairs.",
            )}
          </Typography>
        </Notice>
        {rows.map((row) => renderMatchRow(locale, row, problems))}
      </Flex>
    );
  };

  const renderMatch = () => {
    const matchLocales = Object.keys(matchRows);
    if (matchLocales.length < 2) return renderMatchLocale(matchLocales[0]);
    return (
      <Tabs.Root
        variant="simple"
        value={matchLocale || undefined}
        onValueChange={setMatchLocale}
      >
        <Box paddingBottom={4}>
          <Tabs.List aria-label={t("languagesTabs", "Languages")}>
            {matchLocales.map((locale) => {
              const open = matchProblems(locale).size > 0;
              const Icon = open ? WarningCircle : CheckCircle;
              return (
                <Tabs.Trigger key={locale} value={locale}>
                  <Flex gap={2} alignItems="center" tag="span">
                    {localeName(locale)}
                    <Box
                      color={open ? "warning600" : "success600"}
                      tag="span"
                      aria-hidden
                    >
                      <Icon width="1.2rem" height="1.2rem" />
                    </Box>
                  </Flex>
                </Tabs.Trigger>
              );
            })}
          </Tabs.List>
        </Box>
        {matchLocale && renderMatchLocale(matchLocale)}
      </Tabs.Root>
    );
  };

  const tabIcon = (item) => {
    if (applied[item.locale]) return { Icon: CheckCircle, color: "success600" };
    if (item.state !== "done")
      return STATE_ICON[item.state] || STATE_ICON.failed;
    return null;
  };

  const renderReview = () => (
    <Tabs.Root
      variant="simple"
      value={active || undefined}
      onValueChange={(value) => {
        setActive(value);
        setError(null);
      }}
    >
      {(job?.targets || []).length > 1 && (
        <Box paddingBottom={4}>
          <Tabs.List aria-label={t("languagesTabs", "Languages")}>
            {job.targets.map((item) => {
              const icon = tabIcon(item);
              return (
                <Tabs.Trigger key={item.locale} value={item.locale}>
                  <Flex gap={2} alignItems="center" tag="span">
                    {localeName(item.locale)}
                    {icon && (
                      <Box color={icon.color} tag="span" aria-hidden>
                        <icon.Icon width="1.2rem" height="1.2rem" />
                      </Box>
                    )}
                  </Flex>
                </Tabs.Trigger>
              );
            })}
          </Tabs.List>
        </Box>
      )}
      {applied[active]
        ? renderApplied()
        : preview
          ? renderPreview()
          : renderFailed()}
    </Tabs.Root>
  );

  return (
    <Modal.Root open={open} onOpenChange={(isOpen) => !isOpen && close()}>
      <Modal.Content style={{ maxWidth: 880, width: "calc(100vw - 32px)" }}>
        <Modal.Header>
          <Modal.Title>
            {phase === "match"
              ? Object.keys(matchRows).length === 1
                ? t("titleMatch", "Match modules for {language}", {
                    language: localeName(Object.keys(matchRows)[0]),
                  })
                : t("titleMatchMany", "Match modules")
              : phase === "review" && (job?.targets || []).length === 1
                ? t("titleOne", "Review {language} translation", {
                    language: localeName(active),
                  })
                : t("title", "Translate saved changes")}
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Flex direction="column" alignItems="stretch" gap={6}>
            {error && (
              <Alert
                variant="danger"
                title={t("error", "Something went wrong")}
                onClose={() => setError(null)}
                closeLabel={t("dismiss", "Dismiss")}
              >
                {error}
              </Alert>
            )}
            {phase === "pick" && renderPick()}
            {phase === "match" && renderMatch()}
            {phase === "running" && renderRunning()}
            {phase === "review" && renderReview()}
          </Flex>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="tertiary" onClick={close} disabled={busy}>
            {phase === "pick"
              ? t("later", "Not now")
              : phase === "running" || phase === "match"
                ? t("cancel", "Cancel")
                : allApplied
                  ? t("done", "Done")
                  : t("close", "Close")}
          </Button>
          {phase === "pick" && (
            <Button
              onClick={() => proceed()}
              loading={busy}
              disabled={!sendTargets.length || (!modules.length && !initial)}
            >
              {t("generate", "Preview translations")}
            </Button>
          )}
          {phase === "match" && (
            <Flex gap={2} wrap="wrap" justifyContent="flex-end">
              <Button
                variant="tertiary"
                onClick={() => {
                  setPhase("pick");
                  setError(null);
                }}
                disabled={busy}
              >
                {t("change", "Back")}
              </Button>
              <Button
                onClick={() => proceed()}
                loading={busy}
                disabled={!matchReady}
              >
                {t("matchConfirm", "Confirm and preview")}
              </Button>
            </Flex>
          )}
          {phase === "review" && (
            <Flex gap={2} wrap="wrap" justifyContent="flex-end">
              {!allApplied && (
                <Button variant="tertiary" onClick={backToPick} disabled={busy}>
                  {t("change", "Back")}
                </Button>
              )}
              {preview && !applied[active] && (
                <Button
                  onClick={accept}
                  loading={busy}
                  disabled={blocked || counts.selected === 0}
                >
                  {t("apply", "Apply to {language}", {
                    language: localeName(active),
                  })}
                </Button>
              )}
            </Flex>
          )}
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
