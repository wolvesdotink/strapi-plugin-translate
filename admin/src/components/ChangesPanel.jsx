import React, { useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { useFetchClient, useForm } from "@strapi/strapi/admin";
import { Badge, Button, Flex, Typography } from "@strapi/design-system";
import { ChangesModal } from "./ChangesModal";
import pluginId from "../pluginId";
import { moduleLabel } from "../utils/format";

// A new entry has no panel until its first save creates it and the editor
// switches to the saved entry. Remember that save so the entry's panel can
// open the dialog like it does after an update.
let createdSave = null;
const takeCreatedSave = (model) => {
  const match = createdSave?.model === model;
  createdSave = null;
  return match;
};

const ChangesPanelContent = ({
  model,
  collectionType,
  documentId,
  document,
  activeTab,
}) => {
  const { get, post } = useFetchClient();
  const { formatMessage } = useIntl();
  const t = (key, fallback, values) =>
    formatMessage(
      { id: `${pluginId}.changes.${key}`, defaultMessage: fallback },
      values,
    );
  const isSubmitting = useForm(
    "TranslationChanges",
    (state) => state.isSubmitting,
  );
  const [changes, setChanges] = useState(null),
    [open, setOpen] = useState(false),
    [error, setError] = useState(null),
    [names, setNames] = useState({});
  const saved = useRef(null),
    submitting = useRef(false),
    seen = useRef(null);
  const sourceLocale = document?.locale;
  useEffect(() => {
    if (isSubmitting) submitting.current = true;
  }, [isSubmitting]);
  // `prompt` opens the dialog after the editor's own save; `isCancelled`
  // drops responses for a document the panel no longer shows.
  const refresh = async ({
    prompt = false,
    isCancelled = () => false,
  } = {}) => {
    try {
      const { data } = await post("/translate/changes", {
        uid: model,
        documentId,
        sourceLocale,
      });
      if (isCancelled()) return;
      setChanges(data);
      setError(null);
      if (
        prompt &&
        data.shouldPrompt &&
        data.modules.length &&
        data.revision !== seen.current
      ) {
        seen.current = data.revision;
        setOpen(true);
      }
    } catch (err) {
      if (!isCancelled())
        setError(err?.response?.data?.error?.message || err.message);
    }
  };
  useEffect(() => {
    if (!documentId || !sourceLocale || activeTab === "published") return;
    const identity = `${model}:${documentId}:${sourceLocale}`;
    const previous = saved.current;
    const prompt = previous
      ? previous.identity === identity &&
        previous.updatedAt !== document?.updatedAt &&
        submitting.current
      : takeCreatedSave(model);
    saved.current = { identity, updatedAt: document?.updatedAt };
    if (prompt) submitting.current = false;
    let cancelled = false;
    // Wait for the refreshed document after the save. The source snapshot and
    // tracking record commit together; no click interception or DOM observers.
    refresh({ prompt, isCancelled: () => cancelled });
    return () => {
      cancelled = true;
    };
  }, [model, documentId, sourceLocale, document?.updatedAt, activeTab, post]);
  useEffect(() => {
    let current = true;
    get("/translate/locales")
      .then(({ data }) => {
        if (current)
          setNames(Object.fromEntries(data.map((l) => [l.code, l.name])));
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [get]);
  if (activeTab === "published" || changes?.enabled === false) return null;
  const pending = changes?.modules || [];
  const shown = pending.slice(0, 3);
  // A deleted or never-created language still needs a translation even
  // when no source change is pending.
  const needsWork =
    pending.length > 0 ||
    (changes?.languages || []).some((language) => !language.exists);
  return (
    <Flex direction="column" alignItems="stretch" gap={3} width="100%">
      {error ? (
        <Typography variant="pi" textColor="danger600">
          {error}
        </Typography>
      ) : needsWork ? (
        <Flex direction="column" alignItems="stretch" gap={1}>
          {pending.length > 0 && (
            <Typography variant="pi" fontWeight="bold" textColor="neutral800">
              {t(
                "pending",
                "{count, plural, one {# change} other {# changes}} not translated everywhere yet",
                { count: pending.length },
              )}
            </Typography>
          )}
          {shown.map((module) => (
            <Typography
              key={module.key}
              variant="pi"
              textColor="neutral600"
              ellipsis
            >
              {moduleLabel(module)}
            </Typography>
          ))}
          {pending.length > shown.length && (
            <Typography variant="pi" textColor="neutral500">
              {t("more", "and {count} more", {
                count: pending.length - shown.length,
              })}
            </Typography>
          )}
          {(changes?.languages || []).length > 0 && (
            <Flex
              direction="column"
              alignItems="stretch"
              gap={1}
              paddingTop={2}
            >
              {changes.languages.map((language) => (
                <Flex
                  key={language.locale}
                  justifyContent="space-between"
                  alignItems="center"
                  gap={2}
                >
                  <Typography variant="pi" textColor="neutral800" ellipsis>
                    {names[language.locale] || language.locale}
                  </Typography>
                  {!language.exists ? (
                    <Badge
                      size="S"
                      backgroundColor="warning100"
                      textColor="warning700"
                    >
                      {t("noVersion", "Not created yet")}
                    </Badge>
                  ) : language.modules.length ? (
                    <Badge size="S">
                      {t(
                        "pendingCount",
                        "{count, plural, one {# change} other {# changes}}",
                        { count: language.modules.length },
                      )}
                    </Badge>
                  ) : (
                    <Badge
                      size="S"
                      backgroundColor="success100"
                      textColor="success700"
                    >
                      {t("upToDate", "Up to date")}
                    </Badge>
                  )}
                </Flex>
              ))}
            </Flex>
          )}
        </Flex>
      ) : (
        <Typography variant="pi" textColor="neutral600">
          {changes?.revision
            ? t("allUpToDate", "All languages are up to date.")
            : t(
                "none",
                "No pending changes. Save an edit to translate just the modules you changed.",
              )}
        </Typography>
      )}
      {error ? (
        <Button variant="tertiary" fullWidth onClick={() => refresh()}>
          {t("retry", "Retry")}
        </Button>
      ) : (
        needsWork && (
          <Button variant="secondary" fullWidth onClick={() => setOpen(true)}>
            {t("review", "Translate changes")}
          </Button>
        )
      )}
      {open && (
        <ChangesModal
          open={open}
          onClose={() => setOpen(false)}
          model={model}
          collectionType={collectionType}
          documentId={documentId}
          sourceLocale={sourceLocale}
          changes={changes}
          onApplied={() => refresh()}
          onRefresh={() => refresh()}
        />
      )}
    </Flex>
  );
};

export default function ChangesPanel(props) {
  const { formatMessage } = useIntl();
  const documentId = props.documentId || props.document?.documentId;
  const isSubmitting = useForm(
    "TranslationChangesPanel",
    (state) => state.isSubmitting,
  );
  // A successful create leaves this page for the new entry. A save that
  // finishes while still on the create page failed, so drop it.
  const creating = useRef(false);
  useEffect(() => {
    if (documentId) return;
    if (isSubmitting) {
      creating.current = true;
      createdSave = { model: props.model };
    } else if (creating.current) {
      creating.current = false;
      createdSave = null;
    }
  }, [isSubmitting, documentId, props.model]);
  if (!documentId || !props.document?.locale) return null;
  return {
    title: formatMessage({
      id: `${pluginId}.changes.panel`,
      defaultMessage: "Translation changes",
    }),
    content: <ChangesPanelContent {...props} documentId={documentId} />,
  };
}
