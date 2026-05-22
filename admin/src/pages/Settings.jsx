// Settings page for the Translate plugin. Lives under Settings → Translate.
//
// Three editable sections, all baked into the LLM's system prompt at
// translate-time (see server/services/translate.js -> userSettings):
//   - Voice / tonality (free-form textarea)
//   - Preserve exactly (brand/place terms kept verbatim across all locales)
//   - Per-locale glossary ("source" -> "target" mappings per target locale)
//
// Persistence: GET/PUT /translate/settings, controller backed by strapi.store.
//
// Save semantics: edits stay in local state until the user clicks Save.
// Reset reloads the defaults from config/plugins.js + glossary.json.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import {
  useFetchClient,
  useNotification,
  Layouts,
  Page,
} from "@strapi/strapi/admin";
import {
  Box,
  Button,
  Field,
  Flex,
  IconButton,
  SingleSelect,
  SingleSelectOption,
  Tag,
  Textarea,
  TextInput,
  Typography,
} from "@strapi/design-system";
import {
  ArrowClockwise,
  Check,
  Cross,
  Download,
  Plus,
  Trash,
  Upload,
} from "@strapi/icons";
import pluginId from "../pluginId";

// Convert a millisecond timestamp into a human-readable "X minutes ago" string.
// Cheap and i18n-naive — fine for an admin diagnostics panel where the value
// rarely needs to be precise.
const timeAgo = (ts) => {
  if (!ts) return null;
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};

const formatNumber = (n) => {
  if (typeof n !== "number" || !isFinite(n)) return "—";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
};

const tid = (key) => `${pluginId}.${key}`;

const emptySettings = () => ({
  voice: "",
  glossary: { preserveExact: [], perLocale: {} },
});

const SettingsPage = () => {
  const { formatMessage } = useIntl();
  const { get, put, post, del } = useFetchClient();
  const { toggleNotification } = useNotification();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [supportedLocales, setSupportedLocales] = useState([]);
  const [activeLocale, setActiveLocale] = useState("en");
  const [values, setValues] = useState(emptySettings());
  const [newPreserveTerm, setNewPreserveTerm] = useState("");
  const [newSource, setNewSource] = useState("");
  const [newTarget, setNewTarget] = useState("");

  // Diagnostics state — cache stats + provider credit usage.
  const [cacheStats, setCacheStats] = useState(null);
  const [usage, setUsage] = useState(null);
  const [diagLoading, setDiagLoading] = useState(false);
  const [clearingCache, setClearingCache] = useState(false);

  // Hidden file input ref for glossary import.
  const importInputRef = useRef(null);

  // Initial load. The server returns settings pre-merged with defaults so the
  // form always has something sensible on first render.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    get("/translate/settings")
      .then((res) => {
        if (cancelled) return;
        const data = res.data || {};
        const locales = Array.isArray(data.supportedLocales)
          ? data.supportedLocales
          : [];
        setSupportedLocales(locales);
        setActiveLocale((cur) =>
          locales.includes(cur) ? cur : locales[0] || "en"
        );
        setValues({
          voice: data.voice || "",
          glossary: {
            preserveExact: data.glossary?.preserveExact || [],
            perLocale: data.glossary?.perLocale || {},
          },
        });
      })
      .catch((err) => {
        if (!cancelled) {
          toggleNotification({
            type: "danger",
            message: formatMessage(
              {
                id: tid("settings.toast.loadFailed"),
                defaultMessage: "Failed to load settings: {error}",
              },
              { error: err?.message || "Unknown error" }
            ),
          });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [get, toggleNotification, formatMessage]);

  const perLocaleEntries = useMemo(() => {
    const map = values.glossary.perLocale?.[activeLocale] || {};
    return Object.entries(map);
  }, [values, activeLocale]);

  const setVoice = (next) => setValues((v) => ({ ...v, voice: next }));

  const addPreserveTerm = () => {
    const term = newPreserveTerm.trim();
    if (!term) return;
    setValues((v) => {
      if (v.glossary.preserveExact.includes(term)) return v;
      return {
        ...v,
        glossary: {
          ...v.glossary,
          preserveExact: [...v.glossary.preserveExact, term],
        },
      };
    });
    setNewPreserveTerm("");
  };

  const removePreserveTerm = (term) => {
    setValues((v) => ({
      ...v,
      glossary: {
        ...v.glossary,
        preserveExact: v.glossary.preserveExact.filter((x) => x !== term),
      },
    }));
  };

  const addMapping = () => {
    const source = newSource.trim();
    const target = newTarget.trim();
    if (!source || !target) return;
    setValues((v) => {
      const current = v.glossary.perLocale?.[activeLocale] || {};
      return {
        ...v,
        glossary: {
          ...v.glossary,
          perLocale: {
            ...v.glossary.perLocale,
            [activeLocale]: { ...current, [source]: target },
          },
        },
      };
    });
    setNewSource("");
    setNewTarget("");
  };

  const removeMapping = (source) => {
    setValues((v) => {
      const current = { ...(v.glossary.perLocale?.[activeLocale] || {}) };
      delete current[source];
      return {
        ...v,
        glossary: {
          ...v.glossary,
          perLocale: { ...v.glossary.perLocale, [activeLocale]: current },
        },
      };
    });
  };

  const updateMappingTarget = (source, nextTarget) => {
    setValues((v) => {
      const current = { ...(v.glossary.perLocale?.[activeLocale] || {}) };
      current[source] = nextTarget;
      return {
        ...v,
        glossary: {
          ...v.glossary,
          perLocale: { ...v.glossary.perLocale, [activeLocale]: current },
        },
      };
    });
  };

  const applyResponse = (data) => {
    setValues({
      voice: data?.voice || "",
      glossary: {
        preserveExact: data?.glossary?.preserveExact || [],
        perLocale: data?.glossary?.perLocale || {},
      },
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await put("/translate/settings", values);
      applyResponse(res.data);
      toggleNotification({
        type: "success",
        message: formatMessage({
          id: tid("settings.toast.saved"),
          defaultMessage: "Settings saved.",
        }),
      });
    } catch (err) {
      toggleNotification({
        type: "danger",
        message: formatMessage(
          {
            id: tid("settings.toast.saveFailed"),
            defaultMessage: "Failed to save: {error}",
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
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setResetting(true);
    try {
      const res = await post("/translate/settings/reset");
      applyResponse(res.data);
      toggleNotification({
        type: "success",
        message: formatMessage({
          id: tid("settings.toast.reset"),
          defaultMessage: "Reverted to defaults.",
        }),
      });
    } catch (err) {
      toggleNotification({
        type: "danger",
        message: formatMessage(
          {
            id: tid("settings.toast.resetFailed"),
            defaultMessage: "Failed to reset: {error}",
          },
          { error: err?.message || "Unknown error" }
        ),
      });
    } finally {
      setResetting(false);
    }
  };

  // Diagnostics: fetch cache stats + provider usage in parallel.
  const refreshDiagnostics = async () => {
    setDiagLoading(true);
    const [statsRes, usageRes] = await Promise.allSettled([
      get("/translate/cache/stats"),
      get("/translate/usage"),
    ]);
    if (statsRes.status === "fulfilled") setCacheStats(statsRes.value.data);
    else setCacheStats(null);
    if (usageRes.status === "fulfilled") setUsage(usageRes.value.data);
    else setUsage(null);
    setDiagLoading(false);
  };

  // Refresh diagnostics on initial settings load.
  useEffect(() => {
    if (!loading) refreshDiagnostics();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  const handleClearCache = async () => {
    setClearingCache(true);
    try {
      const res = await del("/translate/cache");
      toggleNotification({
        type: "success",
        message: formatMessage(
          {
            id: tid("settings.toast.cacheCleared"),
            defaultMessage:
              "Cleared {count} cached translation(s).",
          },
          { count: res.data?.cleared || 0 }
        ),
      });
      await refreshDiagnostics();
    } catch (err) {
      toggleNotification({
        type: "danger",
        message: formatMessage(
          {
            id: tid("settings.toast.cacheClearFailed"),
            defaultMessage: "Failed to clear cache: {error}",
          },
          { error: err?.message || "Unknown error" }
        ),
      });
    } finally {
      setClearingCache(false);
    }
  };

  // Glossary export: dump the current in-memory values, not the saved store
  // copy — gives the editor what they see, including unsaved edits.
  const handleExportGlossary = () => {
    const payload = {
      preserveExact: values.glossary.preserveExact,
      perLocale: values.glossary.perLocale,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `glossary-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Glossary import: validate the JSON shape before merging into local state.
  // Doesn't auto-save — the editor still has to click Save.
  const handleImportGlossary = async (file) => {
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const preserveExact = Array.isArray(parsed.preserveExact)
        ? parsed.preserveExact.filter((s) => typeof s === "string" && s.trim())
        : [];
      const perLocale =
        parsed.perLocale && typeof parsed.perLocale === "object"
          ? Object.fromEntries(
              Object.entries(parsed.perLocale)
                .filter(([code]) => supportedLocales.includes(code))
                .map(([code, mappings]) => [
                  code,
                  Object.fromEntries(
                    Object.entries(mappings || {}).filter(
                      ([s, t]) =>
                        typeof s === "string" &&
                        s.trim() &&
                        typeof t === "string" &&
                        t.trim()
                    )
                  ),
                ])
            )
          : {};
      setValues((v) => ({
        ...v,
        glossary: { preserveExact, perLocale },
      }));
      toggleNotification({
        type: "success",
        message: formatMessage({
          id: tid("settings.toast.glossaryImported"),
          defaultMessage:
            "Glossary loaded into the form. Click Save to persist.",
        }),
      });
    } catch (err) {
      toggleNotification({
        type: "danger",
        message: formatMessage(
          {
            id: tid("settings.toast.glossaryImportFailed"),
            defaultMessage: "Failed to import glossary: {error}",
          },
          { error: err?.message || "invalid JSON" }
        ),
      });
    }
  };

  if (loading) {
    return (
      <Page.Main>
        <Page.Title>
          {formatMessage({
            id: tid("settings.title"),
            defaultMessage: "Translate",
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
          id: tid("settings.title"),
          defaultMessage: "Translate",
        })}
      </Page.Title>
      <Layouts.Header
        title={formatMessage({
          id: tid("settings.header.title"),
          defaultMessage: "Translate",
        })}
        subtitle={formatMessage({
          id: tid("settings.header.subtitle"),
          defaultMessage:
            "Tonality and terminology used when translating entries with the LLM.",
        })}
        primaryAction={
          <Button
            startIcon={<Check />}
            onClick={handleSave}
            loading={saving}
            disabled={saving}
          >
            {formatMessage({
              id: tid("settings.action.save"),
              defaultMessage: "Save",
            })}
          </Button>
        }
        secondaryAction={
          <Button
            variant="tertiary"
            startIcon={<ArrowClockwise />}
            onClick={handleReset}
            loading={resetting}
            disabled={resetting}
          >
            {formatMessage({
              id: tid("settings.action.reset"),
              defaultMessage: "Reset to defaults",
            })}
          </Button>
        }
      />
      <Layouts.Content>
        <Flex direction="column" alignItems="stretch" gap={6}>
          <DiagnosticsCard
            cacheStats={cacheStats}
            usage={usage}
            loading={diagLoading}
            onRefresh={refreshDiagnostics}
            onClearCache={handleClearCache}
            clearingCache={clearingCache}
            formatMessage={formatMessage}
          />

          <SectionCard
            title={formatMessage({
              id: tid("settings.voice.title"),
              defaultMessage: "Voice and tone",
            })}
            description={formatMessage({
              id: tid("settings.voice.description"),
              defaultMessage:
                "Free-form instructions injected into the translator's system prompt. Describe the desired voice, register, or product-specific phrasing.",
            })}
          >
            <Field.Root name="voice">
              <Field.Label>
                {formatMessage({
                  id: tid("settings.voice.label"),
                  defaultMessage: "Instructions",
                })}
              </Field.Label>
              <Textarea
                value={values.voice}
                onChange={(e) => setVoice(e.target.value)}
                rows={8}
                placeholder={formatMessage({
                  id: tid("settings.voice.placeholder"),
                  defaultMessage:
                    "e.g. Warm, inviting hospitality copy. Keep tone natural to the target language — do not translate literally.",
                })}
              />
              <Field.Hint>
                {formatMessage({
                  id: tid("settings.voice.hint"),
                  defaultMessage:
                    "Plain text. Avoid contradicting the built-in rules (HTML preservation, JSON output, etc).",
                })}
              </Field.Hint>
            </Field.Root>
          </SectionCard>

          <SectionCard
            title={formatMessage({
              id: tid("settings.preserve.title"),
              defaultMessage: "Preserve exactly",
            })}
            description={formatMessage({
              id: tid("settings.preserve.description"),
              defaultMessage:
                "Terms kept verbatim across all target locales — brand names, place names, product names.",
            })}
          >
            <Flex direction="column" alignItems="stretch" gap={3}>
              <Flex wrap="wrap" gap={2}>
                {values.glossary.preserveExact.length === 0 && (
                  <Typography variant="pi" textColor="neutral500">
                    {formatMessage({
                      id: tid("settings.preserve.empty"),
                      defaultMessage: "No preserved terms yet.",
                    })}
                  </Typography>
                )}
                {values.glossary.preserveExact.map((term) => (
                  <Tag
                    key={term}
                    icon={<Cross />}
                    onClick={() => removePreserveTerm(term)}
                  >
                    {term}
                  </Tag>
                ))}
              </Flex>
              <Flex gap={2} alignItems="flex-end">
                <Box flex="1">
                  <Field.Root name="new-preserve-term">
                    <Field.Label>
                      {formatMessage({
                        id: tid("settings.preserve.addLabel"),
                        defaultMessage: "Add term",
                      })}
                    </Field.Label>
                    <TextInput
                      value={newPreserveTerm}
                      onChange={(e) => setNewPreserveTerm(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addPreserveTerm();
                        }
                      }}
                      placeholder={formatMessage({
                        id: tid("settings.preserve.addPlaceholder"),
                        defaultMessage: "e.g. Hinterland Camp",
                      })}
                    />
                  </Field.Root>
                </Box>
                <Button
                  variant="secondary"
                  startIcon={<Plus />}
                  onClick={addPreserveTerm}
                  disabled={!newPreserveTerm.trim()}
                >
                  {formatMessage({
                    id: tid("settings.action.add"),
                    defaultMessage: "Add",
                  })}
                </Button>
              </Flex>
            </Flex>
          </SectionCard>

          <SectionCard
            title={formatMessage({
              id: tid("settings.glossary.title"),
              defaultMessage: "Per-locale glossary",
            })}
            description={formatMessage({
              id: tid("settings.glossary.description"),
              defaultMessage:
                "When translating to the selected locale, the LLM is told to prefer the target term over a literal translation. Example: \"Motorhome Pitches\" → \"Private Campsites\" for English.",
            })}
            actions={
              <Flex gap={2}>
                <input
                  ref={importInputRef}
                  type="file"
                  accept="application/json"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleImportGlossary(file);
                    e.target.value = "";
                  }}
                />
                <Button
                  variant="tertiary"
                  size="S"
                  startIcon={<Upload />}
                  onClick={() => importInputRef.current?.click()}
                >
                  {formatMessage({
                    id: tid("settings.glossary.import"),
                    defaultMessage: "Import",
                  })}
                </Button>
                <Button
                  variant="tertiary"
                  size="S"
                  startIcon={<Download />}
                  onClick={handleExportGlossary}
                >
                  {formatMessage({
                    id: tid("settings.glossary.export"),
                    defaultMessage: "Export",
                  })}
                </Button>
              </Flex>
            }
          >
            <Flex direction="column" alignItems="stretch" gap={4}>
              <Box maxWidth="260px">
                <Field.Root name="active-locale">
                  <Field.Label>
                    {formatMessage({
                      id: tid("settings.glossary.localeLabel"),
                      defaultMessage: "Target locale",
                    })}
                  </Field.Label>
                  <SingleSelect
                    value={activeLocale}
                    onChange={(v) => setActiveLocale(String(v))}
                  >
                    {supportedLocales.map((code) => (
                      <SingleSelectOption key={code} value={code}>
                        {code.toUpperCase()}
                      </SingleSelectOption>
                    ))}
                  </SingleSelect>
                </Field.Root>
              </Box>

              <Flex direction="column" alignItems="stretch" gap={2}>
                {perLocaleEntries.length === 0 && (
                  <Typography variant="pi" textColor="neutral500">
                    {formatMessage({
                      id: tid("settings.glossary.empty"),
                      defaultMessage: "No mappings yet for this locale.",
                    })}
                  </Typography>
                )}
                {perLocaleEntries.map(([source, target]) => (
                  <Flex
                    key={source}
                    gap={2}
                    alignItems="center"
                    padding={2}
                    background="neutral100"
                    hasRadius
                  >
                    <Box flex="1">
                      <Typography fontWeight="semiBold">{source}</Typography>
                    </Box>
                    <Typography textColor="neutral500">→</Typography>
                    <Box flex="1">
                      <TextInput
                        aria-label={formatMessage(
                          {
                            id: tid("settings.glossary.targetAria"),
                            defaultMessage: "Preferred target for {source}",
                          },
                          { source }
                        )}
                        value={target}
                        onChange={(e) =>
                          updateMappingTarget(source, e.target.value)
                        }
                      />
                    </Box>
                    <IconButton
                      onClick={() => removeMapping(source)}
                      label={formatMessage({
                        id: tid("settings.glossary.removeAria"),
                        defaultMessage: "Remove mapping",
                      })}
                      withTooltip={false}
                    >
                      <Trash />
                    </IconButton>
                  </Flex>
                ))}
              </Flex>

              <Box paddingTop={3}>
                <Flex gap={2} alignItems="flex-end">
                  <Box flex="1">
                    <Field.Root name="new-mapping-source">
                      <Field.Label>
                        {formatMessage({
                          id: tid("settings.glossary.sourceLabel"),
                          defaultMessage: "Source phrase",
                        })}
                      </Field.Label>
                      <TextInput
                        value={newSource}
                        onChange={(e) => setNewSource(e.target.value)}
                        placeholder={formatMessage({
                          id: tid("settings.glossary.sourcePlaceholder"),
                          defaultMessage: "e.g. Motorhome Pitches",
                        })}
                      />
                    </Field.Root>
                  </Box>
                  <Box flex="1">
                    <Field.Root name="new-mapping-target">
                      <Field.Label>
                        {formatMessage({
                          id: tid("settings.glossary.targetLabel"),
                          defaultMessage: "Preferred target",
                        })}
                      </Field.Label>
                      <TextInput
                        value={newTarget}
                        onChange={(e) => setNewTarget(e.target.value)}
                        placeholder={formatMessage({
                          id: tid("settings.glossary.targetPlaceholder"),
                          defaultMessage: "e.g. Private Campsites",
                        })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            addMapping();
                          }
                        }}
                      />
                    </Field.Root>
                  </Box>
                  <Button
                    variant="secondary"
                    startIcon={<Plus />}
                    onClick={addMapping}
                    disabled={!newSource.trim() || !newTarget.trim()}
                  >
                    {formatMessage({
                      id: tid("settings.action.add"),
                      defaultMessage: "Add",
                    })}
                  </Button>
                </Flex>
              </Box>
            </Flex>
          </SectionCard>
        </Flex>
      </Layouts.Content>
    </Page.Main>
  );
};

const SectionCard = ({ title, description, actions, children }) => (
  <Box
    background="neutral0"
    padding={6}
    shadow="filterShadow"
    hasRadius
    borderColor="neutral150"
  >
    <Flex direction="column" alignItems="stretch" gap={4}>
      <Flex justifyContent="space-between" alignItems="flex-start" gap={3}>
        <Box flex="1">
          <Typography variant="delta" tag="h2">
            {title}
          </Typography>
          {description && (
            <Box paddingTop={1}>
              <Typography variant="pi" textColor="neutral600">
                {description}
              </Typography>
            </Box>
          )}
        </Box>
        {actions}
      </Flex>
      {children}
    </Flex>
  </Box>
);

const DiagnosticsCard = ({
  cacheStats,
  usage,
  loading,
  onRefresh,
  onClearCache,
  clearingCache,
  formatMessage,
}) => {
  const usageRatio =
    usage && typeof usage.limit === "number" && usage.limit > 0
      ? Math.min(100, Math.round((usage.count / usage.limit) * 100))
      : null;
  return (
    <SectionCard
      title={formatMessage({
        id: tid("settings.diagnostics.title"),
        defaultMessage: "Diagnostics",
      })}
      description={formatMessage({
        id: tid("settings.diagnostics.description"),
        defaultMessage:
          "Translation memory cache and provider credit usage. Refresh to read the live state.",
      })}
      actions={
        <Button
          variant="tertiary"
          size="S"
          startIcon={<ArrowClockwise />}
          onClick={onRefresh}
          loading={loading}
          disabled={loading}
        >
          {formatMessage({
            id: tid("settings.diagnostics.refresh"),
            defaultMessage: "Refresh",
          })}
        </Button>
      }
    >
      <Flex gap={4} wrap="wrap">
        <Box
          flex="1"
          minWidth="240px"
          padding={4}
          background="neutral100"
          hasRadius
          borderColor="neutral200"
          borderWidth="1px"
          borderStyle="solid"
        >
          <Typography variant="sigma" textColor="neutral600">
            {formatMessage({
              id: tid("settings.diagnostics.cache"),
              defaultMessage: "Translation cache",
            })}
          </Typography>
          <Box paddingTop={2}>
            <Typography variant="alpha" fontWeight="bold">
              {cacheStats ? formatNumber(cacheStats.size) : "—"}
            </Typography>
            <Box paddingTop={1}>
              <Typography variant="pi" textColor="neutral600">
                {cacheStats && cacheStats.size > 0
                  ? formatMessage(
                      {
                        id: tid("settings.diagnostics.cacheDetail"),
                        defaultMessage:
                          "{hits} hits · oldest {oldest}, newest {newest}",
                      },
                      {
                        hits: formatNumber(cacheStats.totalHits || 0),
                        oldest: timeAgo(cacheStats.oldest) || "—",
                        newest: timeAgo(cacheStats.newest) || "—",
                      }
                    )
                  : cacheStats && cacheStats.size === 0
                  ? formatMessage({
                      id: tid("settings.diagnostics.cacheEmpty"),
                      defaultMessage: "No cached translations yet.",
                    })
                  : formatMessage({
                      id: tid("settings.diagnostics.cacheUnknown"),
                      defaultMessage: "Refresh to load.",
                    })}
              </Typography>
            </Box>
            {cacheStats && cacheStats.enabled === false && (
              <Box paddingTop={1}>
                <Typography variant="pi" textColor="warning700">
                  {formatMessage({
                    id: tid("settings.diagnostics.cacheDisabled"),
                    defaultMessage:
                      "Cache is disabled in plugin config (cache.enabled: false).",
                  })}
                </Typography>
              </Box>
            )}
          </Box>
          <Box paddingTop={3}>
            <Button
              variant="danger-light"
              size="S"
              startIcon={<Trash />}
              onClick={onClearCache}
              loading={clearingCache}
              disabled={clearingCache || !cacheStats || cacheStats.size === 0}
            >
              {formatMessage({
                id: tid("settings.diagnostics.clearCache"),
                defaultMessage: "Clear cache",
              })}
            </Button>
          </Box>
        </Box>

        <Box
          flex="1"
          minWidth="240px"
          padding={4}
          background="neutral100"
          hasRadius
          borderColor="neutral200"
          borderWidth="1px"
          borderStyle="solid"
        >
          <Typography variant="sigma" textColor="neutral600">
            {formatMessage({
              id: tid("settings.diagnostics.usage"),
              defaultMessage: "Provider credit usage",
            })}
          </Typography>
          <Box paddingTop={2}>
            <Typography variant="alpha" fontWeight="bold">
              {usage
                ? `$${(usage.count || 0).toFixed(2)}`
                : "—"}
            </Typography>
            <Box paddingTop={1}>
              <Typography variant="pi" textColor="neutral600">
                {usage && typeof usage.limit === "number" && usage.limit > 0
                  ? formatMessage(
                      {
                        id: tid("settings.diagnostics.usageOfLimit"),
                        defaultMessage:
                          "used of ${limit} ({pct}%)",
                      },
                      {
                        limit: usage.limit.toFixed(2),
                        pct: usageRatio,
                      }
                    )
                  : usage
                  ? formatMessage({
                      id: tid("settings.diagnostics.usageNoLimit"),
                      defaultMessage:
                        "used. No credit limit configured.",
                    })
                  : formatMessage({
                      id: tid("settings.diagnostics.usageUnknown"),
                      defaultMessage: "Refresh to load.",
                    })}
              </Typography>
            </Box>
            {usage?.error && (
              <Box paddingTop={1}>
                <Typography variant="pi" textColor="danger600">
                  {usage.error}
                </Typography>
              </Box>
            )}
          </Box>
        </Box>
      </Flex>
    </SectionCard>
  );
};

export default SettingsPage;
