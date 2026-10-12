import React, { useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { useFetchClient, useForm } from "@strapi/strapi/admin";
import { Button, Flex, Typography } from "@strapi/design-system";
import { ChangesModal } from "./ChangesModal";
import pluginId from "../pluginId";

const ChangesPanelContent = ({ model, documentId, document, activeTab }) => {
  const { post } = useFetchClient();
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
    [error, setError] = useState(null);
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
    const prompt =
      previous?.identity === identity &&
      previous.updatedAt !== document?.updatedAt &&
      submitting.current;
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
  if (activeTab === "published" || changes?.enabled === false) return null;
  const pending = changes?.modules || [];
  const shown = pending.slice(0, 3);
  return (
    <Flex direction="column" alignItems="stretch" gap={3}>
      {error ? (
        <Typography variant="pi" textColor="danger600">
          {error}
        </Typography>
      ) : pending.length ? (
        <Flex direction="column" alignItems="stretch" gap={1}>
          <Typography variant="pi" fontWeight="bold" textColor="neutral800">
            {t(
              "pending",
              "{count, plural, one {# module changed} other {# modules changed}} since the last translation",
              { count: pending.length },
            )}
          </Typography>
          {shown.map((module) => (
            <Typography
              key={module.key}
              variant="pi"
              textColor="neutral600"
              ellipsis
            >
              {module.label}
            </Typography>
          ))}
          {pending.length > shown.length && (
            <Typography variant="pi" textColor="neutral500">
              {t("more", "and {count} more", {
                count: pending.length - shown.length,
              })}
            </Typography>
          )}
        </Flex>
      ) : (
        <Typography variant="pi" textColor="neutral600">
          {t(
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
        pending.length > 0 && (
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
  if (!documentId || !props.document?.locale) return null;
  return {
    title: formatMessage({
      id: `${pluginId}.changes.panel`,
      defaultMessage: "Translation changes",
    }),
    content: <ChangesPanelContent {...props} documentId={documentId} />,
  };
}
