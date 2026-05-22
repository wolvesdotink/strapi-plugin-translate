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

import React, { useEffect, useMemo, useState } from "react";
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
import { ArrowClockwise, Check, Cross, Plus, Trash } from "@strapi/icons";
import pluginId from "../pluginId";

const tid = (key) => `${pluginId}.${key}`;

const emptySettings = () => ({
  voice: "",
  glossary: { preserveExact: [], perLocale: {} },
});

const SettingsPage = () => {
  const { formatMessage } = useIntl();
  const { get, put, post } = useFetchClient();
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

const SectionCard = ({ title, description, children }) => (
  <Box
    background="neutral0"
    padding={6}
    shadow="filterShadow"
    hasRadius
    borderColor="neutral150"
  >
    <Flex direction="column" alignItems="stretch" gap={4}>
      <Box>
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
      {children}
    </Flex>
  </Box>
);

export default SettingsPage;
